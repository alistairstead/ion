import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as aws from "@pulumi/aws";
import {
  ComponentResourceOptions,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { Cdn, CdnDomainArgs } from "./cdn.js";
import { Bucket } from "./bucket.js";
import { Component, Prettify } from "../component.js";
import { Hint } from "../hint.js";
import { Link } from "../link.js";
import { Input } from "../input.js";
import { VisibleError } from "../error.js";
import { execSync } from "child_process";
import { globSync } from "glob";
import { BucketFile, BucketFiles } from "./providers/bucket-files.js";
import { DistributionInvalidation } from "./providers/distribution-invalidation.js";

interface FileOptions {
  /**
   * A glob pattern or array of glob patterns of files to apply these options to.
   */
  files: string | string[];
  /**
   * A glob pattern or array of glob patterns of files to exclude from the ones matched
   * by the `files` glob pattern.
   */
  ignore?: string | string[];
  /**
   * The `Cache-Control` header to apply to the matched files.
   */
  cacheControl?: string;
  /**
   * The `Content-Type` header to apply to the matched files.
   */
  contentType?: string;
}

export interface StaticSiteArgs {
  /**
   * Path to the directory where the app is located.
   * @default `"."`
   */
  path?: Input<string>;
  /**
   * The name of the index page (e.g. "index.html") of the website.
   * @default `index.html`
   * @example
   * ```js
   * {
   *   indexPage: "other-index.html",
   * }
   * ```
   */
  indexPage?: string;
  /**
   * An object with the key being the environment variable name.
   *
   * @example
   * ```js
   * environment: {
   *   API_URL: api.url,
   *   USER_POOL_CLIENT: auth.cognitoUserPoolClient.userPoolClientId,
   * },
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * Set a custom domain for your SSR site. Supports domains hosted either on
   * [Route 53](https://aws.amazon.com/route53/) or outside AWS.
   *
   * :::tip
   * You can also migrate an externally hosted domain to Amazon Route 53 by
   * [following this guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html).
   * :::
   *
   * @example
   *
   * ```js
   * {
   *   domain: "domain.com"
   * }
   * ```
   *
   * Specify the Route 53 hosted zone and a `www.` version of the custom domain.
   *
   * ```js
   * {
   *   domain: {
   *     domainName: "domain.com",
   *     hostedZone: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   */
  domain?: Input<string | Prettify<CdnDomainArgs>>;
  /**
   * The command for building the website
   * @default `npm run build`
   * @example
   * ```js
   * {
   *   buildCommand: "yarn build"
   * }
   * ```
   */
  buildCommand?: Input<string>;
  /**
   * The directory with the content that will be uploaded to the S3 bucket. If a `buildCommand` is provided, this is usually where the build output is generated. The path is relative to the [`path`](#path) where the website source is located.
   * @default entire "path" directory
   * @example
   * ```js
   * {
   *   buildOutput: "build",
   * }
   * ```
   */
  buildOutput?: Input<string>;
  vite?: Input<{
    /**
     * The path where code-gen should place the type definition for environment variables
     * @default "src/sst-env.d.ts"
     * @example
     * ```js
     * {
     *   vite: {
     *     types: "./other/path/sst-env.d.ts",
     *   }
     * }
     * ```
     */
    types?: string;
  }>;
  /**
   * Configure how the assets uploaded to S3.
   *
   * Default text encoding is `utf-8`.
   * Default cache control is:
   * - `max-age=0,no-cache,no-store,must-revalidate` for HTML files
   * - `max-age=31536000,public,immutable` for JS/CSS files
   */
  assets?: Input<{
    /**
     * Character encoding for text based assets uploaded to S3, like HTML, CSS, JS. This is
     * used to set the `Content-Type` header when these files are served out.
     *
     * If set to `"none"`, then no charset will be returned in header.
     * @default `"utf-8"`
     * @example
     * ```js
     * {
     *   assets: {
     *     textEncoding: "iso-8859-1"
     *   }
     * }
     * ```
     */
    textEncoding?: Input<
      "utf-8" | "iso-8859-1" | "windows-1252" | "ascii" | "none"
    >;
    /**
     * Pass in a list of file options to configure cache control for different files. Behind the scenes, the `StaticSite` construct uses a combination of the `s3 cp` and `s3 sync` commands to upload the website content to the S3 bucket. An `s3 cp` command is run for each file option block, and the options are passed in as the command options.
     * @example
     * ```js
     * assets: {
     *   fileOptions: [
     *     {
     *       files: "**\/*.zip",
     *       cacheControl: "private,no-cache,no-store,must-revalidate",
     *       contentType: "application/zip",
     *     },
     *   ],
     * }
     * ```
     */
    fileOptions?: Input<Prettify<FileOptions>[]>;
  }>;
  /**
   * Configure how the CloudFront cache invalidations are handled.
   * @default `&lcub;wait: false, paths: "all"&rcub;`
   * @example
   * Disable invalidation.
   * ```js
   * {
   *   invalidation: false
   * }
   * ```
   */
  invalidation?: Input<
    | false
    | {
        /**
         * Configure if `sst deploy` should wait for the CloudFront cache invalidation to finish.
         *
         * :::tip
         * For non-prod environments it might make sense to pass in `false`.
         * :::
         *
         * Waiting for the CloudFront cache invalidation process to finish ensures that the new content will be served once the deploy finishes. However, this process can sometimes take more than 5 mins.
         * @default `false`
         * @example
         * ```js
         * {
         *   invalidation: {
         *     wait: true
         *   }
         * }
         * ```
         */
        wait?: Input<boolean>;
        /**
         * The paths to invalidate.
         *
         * You can either pass in an array of glob patterns to invalidate specific files. Or you can use the built-in option `all` to invalidation all files when any file changes.
         *
         * :::note
         * Invalidating `all` counts as one invalidation, while each glob pattern counts as a single invalidation path.
         * :::
         * @default `"all"`
         * @example
         * Invalidate the `index.html` and all files under the `products/` route.
         * ```js
         * {
         *   invalidation: {
         *     paths: ["/index.html", "/products/*"]
         *   }
         * }
         * ```
         */
        paths?: Input<"all" | string[]>;
      }
  >;
}

/**
 * The `Astro` component lets you deploy an Astro site to AWS.
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy the Astro site that's in the project root.
 *
 * ```js
 * new sst.aws.Astro("Web");
 * ```
 *
 * #### Change the path
 *
 * Deploys the Astro site in the `my-astro-app/` directory.
 *
 * ```js {2}
 * new sst.aws.Astro("Web", {
 *   path: "my-astro-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your Astro site.
 *
 * ```js {2}
 * new sst.aws.Astro("Web", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4}
 * new sst.aws.Astro("Web", {
 *   domain: {
 *     domainName: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your Astro site. This will grant permissions
 * to the resources and allow you to access it in your site.
 *
 * ```ts {4}
 * const myBucket = new sst.aws.Bucket("MyBucket");
 *
 * new sst.aws.Astro("Web", {
 *   link: [myBucket]
 * });
 * ```
 *
 * You can use the [Node client](/docs/reference/client/) to access the linked resources
 * in your Astro site.
 *
 * ```astro title="src/pages/index.astro"
 * ---
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ---
 * ```
 */
export class StaticSite extends Component implements Link.Linkable {
  private cdn: Cdn;
  private assets: Bucket;

  constructor(
    name: string,
    args: StaticSiteArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super("sst:aws:StaticSite", name, args, opts);

    const parent = this;
    const sitePath = normalizeSitePath();
    const environment = normalizeEnvironment();
    const indexPage = normalizeIndexPage();
    generateViteTypes();
    const outputPath = buildApp();
    const access = createCloudFrontOriginAccessIdentity();
    const bucket = createS3Bucket();

    const bucketFile = uploadAssets();
    const distribution = createDistribution();
    createDistributionInvalidation();

    this.assets = bucket;
    this.cdn = distribution;
    Hint.register(
      this.urn,
      all([this.cdn.domainUrl, this.cdn.url]).apply(
        ([domainUrl, url]) => domainUrl ?? url,
      ),
    );
    this.registerOutputs({
      _metadata: {
        path: sitePath,
        environment,
        customDomainUrl: this.cdn.domainUrl,
        url: this.cdn.url,
      },
    });

    function normalizeSitePath() {
      return output(args.path).apply((sitePath) => {
        if (!sitePath) return ".";

        if (!fs.existsSync(sitePath)) {
          throw new VisibleError(
            `No site found at "${path.resolve(sitePath)}"`,
          );
        }
        return sitePath;
      });
    }

    function normalizeEnvironment() {
      return output(args.environment).apply((environment) => environment ?? {});
    }

    function normalizeIndexPage() {
      return output(args.indexPage).apply(
        (indexPage) => indexPage ?? "index.html",
      );
    }

    function createCloudFrontOriginAccessIdentity() {
      return new aws.cloudfront.OriginAccessIdentity(
        `${name}OriginAccessIdentity`,
        {},
        { parent },
      );
    }

    function createS3Bucket() {
      const bucket = new Bucket(
        `${name}Assets`,
        {},
        { parent, retainOnDelete: false },
      );

      // allow access from another account bucket policy
      new aws.s3.BucketPolicy(
        `${name}AssetsOriginAccessPolicy`,
        {
          bucket: bucket.name,
          policy: aws.iam.getPolicyDocumentOutput({
            statements: [
              {
                principals: [
                  {
                    type: "AWS",
                    identifiers: [access.iamArn],
                  },
                ],
                actions: ["s3:GetObject"],
                resources: [interpolate`${bucket.arn}/*`],
              },
            ],
          }).json,
        },
        { parent },
      );
      return bucket;
    }

    function generateViteTypes() {
      return all([sitePath, args.vite, environment]).apply(
        ([sitePath, vite, environment]) => {
          // Build the path
          let typesPath = vite?.types;
          if (!typesPath) {
            if (
              fs.existsSync(path.join(sitePath, "vite.config.js")) ||
              fs.existsSync(path.join(sitePath, "vite.config.ts"))
            ) {
              typesPath = "src/sst-env.d.ts";
            }
          }
          if (!typesPath) {
            return;
          }

          // Create type file
          const filePath = path.resolve(path.join(sitePath, typesPath));
          const content = `/// <reference types="vite/client" />
  interface ImportMetaEnv {
  ${Object.keys(environment)
    .map((key) => `  readonly ${key}: string`)
    .join("\n")}
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }`;

          const fileDir = path.dirname(filePath);
          fs.mkdirSync(fileDir, { recursive: true });
          fs.writeFileSync(filePath, content);
        },
      );
    }

    function buildApp() {
      return all([
        sitePath,
        args.buildCommand,
        args.buildOutput,
        environment,
      ]).apply(([sitePath, buildCommand, buildOutput, environment]) => {
        if ($dev)
          return path.join($cli.paths.platform, "functions", "empty-site");

        // Run build
        if (buildCommand && !process.env.SKIP) {
          console.debug(`Running "${buildCommand}" script`);
          try {
            execSync(buildCommand, {
              cwd: sitePath,
              stdio: "inherit",
              env: {
                ...process.env,
                ...environment,
              },
            });
          } catch (e) {
            throw new VisibleError(
              `There was a problem building the "${name}" site.`,
            );
          }
        }

        // Validate build output
        const outputPath = buildOutput ?? sitePath;
        if (!fs.existsSync(outputPath)) {
          throw new VisibleError(
            `No build output found at "${path.resolve(outputPath)}"`,
          );
        }

        return outputPath;
      });
    }

    function uploadAssets() {
      return all([outputPath, args.assets]).apply(
        async ([outputPath, assets]) => {
          const bucketFiles: BucketFile[] = [];

          // Build fileOptions
          const fileOptions: FileOptions[] = [
            {
              files: "**",
              cacheControl: "max-age=0,no-cache,no-store,must-revalidate",
            },
            {
              files: ["**/*.js", "**/*.css"],
              cacheControl: "max-age=31536000,public,immutable",
            },
            ...(assets?.fileOptions ?? []),
          ];

          // Upload files based on fileOptions
          const filesUploaded: string[] = [];
          for (const fileOption of fileOptions.reverse()) {
            const files = globSync(fileOption.files, {
              cwd: path.resolve(outputPath),
              nodir: true,
              dot: true,
              ignore: fileOption.ignore,
            }).filter((file) => !filesUploaded.includes(file));

            bucketFiles.push(
              ...(await Promise.all(
                files.map(async (file) => {
                  const source = path.resolve(outputPath, file);
                  const content = await fs.promises.readFile(source);
                  const hash = crypto
                    .createHash("sha256")
                    .update(content)
                    .digest("hex");
                  return {
                    source,
                    key: file,
                    hash,
                    cacheControl: fileOption.cacheControl,
                    contentType: getContentType(file, "UTF-8"),
                  };
                }),
              )),
            );
            filesUploaded.push(...files);
          }

          return new BucketFiles(
            `${name}AssetFiles`,
            {
              bucketName: bucket.name,
              files: bucketFiles,
            },
            { parent, ignoreChanges: $dev ? ["*"] : undefined },
          );
        },
      );
    }

    function getContentType(filename: string, textEncoding: string) {
      const ext = filename.endsWith(".well-known/site-association-json")
        ? ".json"
        : path.extname(filename);
      const extensions = {
        [".txt"]: { mime: "text/plain", isText: true },
        [".htm"]: { mime: "text/html", isText: true },
        [".html"]: { mime: "text/html", isText: true },
        [".xhtml"]: { mime: "application/xhtml+xml", isText: true },
        [".css"]: { mime: "text/css", isText: true },
        [".js"]: { mime: "text/javascript", isText: true },
        [".mjs"]: { mime: "text/javascript", isText: true },
        [".apng"]: { mime: "image/apng", isText: false },
        [".avif"]: { mime: "image/avif", isText: false },
        [".gif"]: { mime: "image/gif", isText: false },
        [".jpeg"]: { mime: "image/jpeg", isText: false },
        [".jpg"]: { mime: "image/jpeg", isText: false },
        [".png"]: { mime: "image/png", isText: false },
        [".svg"]: { mime: "image/svg+xml", isText: true },
        [".bmp"]: { mime: "image/bmp", isText: false },
        [".tiff"]: { mime: "image/tiff", isText: false },
        [".webp"]: { mime: "image/webp", isText: false },
        [".ico"]: { mime: "image/vnd.microsoft.icon", isText: false },
        [".eot"]: { mime: "application/vnd.ms-fontobject", isText: false },
        [".ttf"]: { mime: "font/ttf", isText: false },
        [".otf"]: { mime: "font/otf", isText: false },
        [".woff"]: { mime: "font/woff", isText: false },
        [".woff2"]: { mime: "font/woff2", isText: false },
        [".json"]: { mime: "application/json", isText: true },
        [".jsonld"]: { mime: "application/ld+json", isText: true },
        [".xml"]: { mime: "application/xml", isText: true },
        [".pdf"]: { mime: "application/pdf", isText: false },
        [".zip"]: { mime: "application/zip", isText: false },
        [".wasm"]: { mime: "application/wasm", isText: false },
      };
      const extensionData = extensions[ext as keyof typeof extensions];
      const mime = extensionData?.mime ?? "application/octet-stream";
      const charset =
        extensionData?.isText && textEncoding !== "none"
          ? `;charset=${textEncoding}`
          : "";
      return `${mime}${charset}`;
    }

    function createDistribution() {
      return new Cdn(
        `${name}Cdn`,
        {
          domain: args.domain,
          wait: !$dev,
          transform: {
            distribution: (distribution) => ({
              ...distribution,
              comment: `${name} site`,
              origins: [
                {
                  originId: "s3",
                  domainName: bucket.nodes.bucket.bucketRegionalDomainName,
                  originPath: "",
                  s3OriginConfig: {
                    originAccessIdentity: access.cloudfrontAccessIdentityPath,
                  },
                },
              ],
              defaultRootObject: indexPage,
              errorResponses: [
                {
                  httpStatus: 403,
                  responsePagePath: interpolate`/${indexPage}`,
                  responseHttpStatus: 200,
                },
                {
                  httpStatus: 404,
                  responsePagePath: interpolate`/${indexPage}`,
                  responseHttpStatus: 200,
                },
              ],
              defaultCacheBehavior: {
                targetOriginId: "s3",
                viewerProtocolPolicy: "redirect-to-https",
                allowedMethods: ["GET", "HEAD", "OPTIONS"],
                cachedMethods: ["GET", "HEAD"],
                compress: true,
                // CloudFront's managed CachingOptimized policy
                cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
              },
              customErrorResponses: [
                {
                  errorCode: 404,
                  responseCode: 200,
                  responsePagePath: "/404.html",
                },
              ],
            }),
          },
        },
        // create distribution after s3 upload finishes
        { dependsOn: bucketFile, parent },
      );
    }

    function createDistributionInvalidation() {
      all([outputPath, args.invalidation]).apply(
        ([outputPath, invalidationRaw]) => {
          // Normalize invalidation
          if (invalidationRaw === false) return;
          const invalidation = {
            wait: false,
            paths: "all" as const,
            ...invalidationRaw,
          };

          // Build invalidation paths
          const invalidationPaths =
            invalidation.paths === "all" ? ["/*"] : invalidation.paths;
          if (invalidationPaths.length === 0) return;

          // Calculate a hash based on the contents of the S3 files. This will be
          // used to determine if we need to invalidate our CloudFront cache.
          //
          // The below options are needed to support following symlinks when building zip files:
          // - nodir: This will prevent symlinks themselves from being copied into the zip.
          // - follow: This will follow symlinks and copy the files within.
          const hash = crypto.createHash("md5");
          globSync("**", {
            dot: true,
            nodir: true,
            follow: true,
            cwd: path.resolve(outputPath),
          }).forEach((filePath) =>
            hash.update(fs.readFileSync(path.resolve(outputPath, filePath))),
          );

          new DistributionInvalidation(
            `${name}Invalidation`,
            {
              distributionId: distribution.nodes.distribution.id,
              paths: invalidationPaths,
              version: hash.digest("hex"),
              wait: invalidation.wait,
            },
            {
              parent,
              ignoreChanges: $dev ? ["*"] : undefined,
            },
          );
        },
      );
    }
  }

  /**
   * The URL of the Astro site.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the autogenerated CloudFront URL.
   */
  public get url() {
    return all([this.cdn.domainUrl, this.cdn.url]).apply(
      ([domainUrl, url]) => domainUrl ?? url,
    );
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    return {
      /**
       * The Amazon S3 Bucket that stores the assets.
       */
      assets: this.assets,
    };
  }

  /** @internal */
  public getSSTLink() {
    return {
      properties: {
        url: this.url,
      },
    };
  }
}

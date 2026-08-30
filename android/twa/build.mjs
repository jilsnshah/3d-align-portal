/* Build the Android app without the interactive CLI.

   bubblewrap's command line is an inquirer wrapper: it crashes outright the
   moment it cannot find a terminal, so it cannot run from a script or from CI.
   The library underneath has no such opinion, so the project is generated,
   compiled and signed straight from it.
*/
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire("/opt/homebrew/lib/node_modules/@bubblewrap/cli/");
const {
  AndroidSdkTools, Config, GradleWrapper, JarSigner, JdkHelper,
  ConsoleLog, TwaGenerator, TwaManifest,
} = require("@bubblewrap/core");

const cwd = process.cwd();
const log = new ConsoleLog("build");
const home = process.env.HOME;

const config = new Config(
  // JdkHelper appends Contents/Home itself on macOS, so this is the bundle
  // root rather than the home inside it.
  "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk",
  `${home}/android-sdk`,
);

const manifest = await TwaManifest.fromFile(path.join(cwd, "twa-manifest.json"));

log.info("Generating the Android project…");
await new TwaGenerator(log).createTwaProject(cwd, manifest, log);

// The CLI writes a manifest-checksum.txt so a later interactive run knows the
// project still matches. Nothing here reads it, and the build does not need it.

// The generated wrapper fetches Gradle from services.gradle.org, which answers
// with a redirect the wrapper does not follow here. The distribution is fetched
// once by hand and read from disk instead. This has to happen after the project
// is generated, because generating it rewrites this file.
const wrapperProps = path.join(cwd, "gradle/wrapper/gradle-wrapper.properties");
const localDist = `file\\://${process.env.HOME}/gradle-dist/gradle-8.11.1-bin.zip`;
await writeFile(
  wrapperProps,
  (await readFile(wrapperProps, "utf8"))
    .split("\n")
    .map((l) => (l.startsWith("distributionUrl=") ? `distributionUrl=${localDist}` : l))
    .join("\n"),
);
log.info("Gradle will be read from disk.");

const jdkHelper = new JdkHelper(process, config);
const androidSdkTools = await AndroidSdkTools.create(process, config, jdkHelper, log);
const gradle = new GradleWrapper(process, androidSdkTools, cwd);
const jarSigner = new JarSigner(jdkHelper);

const passwords = {
  keystorePassword: process.env.BUBBLEWRAP_KEYSTORE_PASSWORD,
  keyPassword: process.env.BUBBLEWRAP_KEY_PASSWORD,
};

log.info("Compiling the APK…");
await gradle.assembleRelease();
await androidSdkTools.zipalignOnlyVerification(
  "./app/build/outputs/apk/release/app-release-unsigned.apk",
  "./app-release-unsigned-aligned.apk",
).catch(async () => {
  await androidSdkTools.zipalign(
    "./app/build/outputs/apk/release/app-release-unsigned.apk",
    "./app-release-unsigned-aligned.apk",
  );
});
await androidSdkTools.apksigner(
  manifest.signingKey.path, passwords.keystorePassword,
  manifest.signingKey.alias, passwords.keyPassword,
  "./app-release-unsigned-aligned.apk", "./app-release-signed.apk",
);

log.info("Compiling the Play Store bundle…");
await gradle.bundleRelease();
await jarSigner.sign(
  manifest.signingKey, passwords.keystorePassword, passwords.keyPassword,
  "./app/build/outputs/bundle/release/app-release.aab", "./app-release-bundle.aab",
);

log.info("Done.");

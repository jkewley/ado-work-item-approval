/*
 * Fails the package step if webpack emitted a font that vss-extension.json does not
 * declare. tfx only applies a contentType to an individually named file entry, so an
 * undeclared font would be packaged as application/octet-stream (or silently dropped)
 * and reintroduce the warning this guards against.
 */
const fs = require("fs");
const path = require("path");

const fontDir = path.resolve(__dirname, "../dist/assets/fonts");
if (!fs.existsSync(fontDir)) {
    process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../vss-extension.json"), "utf8"));
const declared = new Set(
    // Manifest paths are always written with forward slashes.
    manifest.files.map(entry => entry.path.split("/").pop())
);

const undeclared = fs.readdirSync(fontDir).filter(name => !declared.has(name));
if (undeclared.length > 0) {
    console.error(
        `\nvss-extension.json is missing file entries for these fonts:\n` +
            undeclared.map(name => `  assets/fonts/${name}`).join("\n") +
            `\n\nAdd an entry per font with the matching contentType (font/woff2 or font/woff).\n`
    );
    process.exit(1);
}

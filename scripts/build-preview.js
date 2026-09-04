/*
 * Assembles preview/ into a standalone page showing every button state, so the colors
 * can be reviewed without packaging the extension and installing it into an org.
 *
 * Copies the azure-devops-ui stylesheets the control depends on and compiles the
 * control's own SCSS beside them. Open preview/index.html in a browser afterwards.
 */
const fs = require("fs");
const path = require("path");
const sass = require("sass");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "preview");
const ui = path.join(root, "node_modules", "azure-devops-ui");

const copies = [
    [path.join(ui, "Core", "override.css"), "ado-override.css"],
    [path.join(ui, "Components", "Button", "Button.css"), "ado-button.css"]
];

for (const [from, to] of copies) {
    fs.copyFileSync(from, path.join(out, to));
}

// Compiled through the sass JS API rather than the CLI: spawning npx does not resolve
// on Windows without a shell, and sass is already a dependency.
const compiled = sass.compile(path.join(root, "src", "ApprovalControl", "ApprovalControl.scss"), {
    loadPaths: [path.join(root, "node_modules")],
    style: "expanded",
    silenceDeprecations: ["import"]
});
fs.writeFileSync(path.join(out, "control.css"), compiled.css);

console.log(`Preview ready: ${path.join(out, "index.html")}`);

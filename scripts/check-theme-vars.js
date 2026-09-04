/*
 * Fails if one of this control's own rules reads a theme variable that nothing guarantees
 * a value for.
 *
 * The platform's SASS variables expand to a bare `var(--x)` with no inline fallback. When
 * the host does not publish `--x`, the declaration is invalid at computed-value time and
 * the property silently reverts to its initial value: a button with no background rather
 * than a visible error. ApprovalControl.scss therefore declares defaults in `:root`, and
 * this check keeps the two in step.
 *
 * Only rules that style this control are inspected. azure-devops-ui's own rules read
 * plenty of variables that are the platform's business, not ours.
 */
const path = require("path");
const sass = require("sass");

const root = path.resolve(__dirname, "..");

const css = sass.compile(path.join(root, "src", "ApprovalControl", "ApprovalControl.scss"), {
    loadPaths: [path.join(root, "node_modules")],
    style: "expanded",
    silenceDeprecations: ["import"]
}).css;

// Variables the stylesheet gives a default value to, i.e. the `:root { --x: y }` block.
const defined = new Set();
for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const decl of block[1].matchAll(/(--[\w-]+)\s*:/g)) {
        defined.add(decl[1]);
    }
}

// Variables read without an inline fallback, by rules belonging to this control.
const missing = new Map();
for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, selector, body] = rule;
    if (!selector.includes("approval-control")) {
        continue;
    }
    for (const read of body.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        const name = read[1];
        if (!defined.has(name)) {
            missing.set(name, selector.trim().split("\n")[0].trim());
        }
    }
}

if (missing.size > 0) {
    console.error("\nThese theme variables are read with no fallback and no :root default:\n");
    for (const [name, selector] of missing) {
        console.error(`  ${name}\n      first read by: ${selector}`);
    }
    console.error(
        "\nAdd a default to the :root block in ApprovalControl.scss (use the value" +
            "\nazure-devops-ui ships as its own inline fallback), or write the fallback inline.\n"
    );
    process.exit(1);
}

console.log(`Theme variables OK: ${defined.size} defaults cover every unguarded read.`);

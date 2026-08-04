// @ts-nocheck — vendored from workos/packages/design-system by
// `npm run sync-design-system`, which overwrites this file. Edit it upstream.
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

// Build a list of breakpoints from "@custom media" rules in "breakpoints.css"
const breakpointsFile = path.resolve(__dirname, 'breakpoints.css');
const breakpointsCss = fs.readFileSync(breakpointsFile, 'utf-8');
const breakpoints = postcss
  .parse(breakpointsCss)
  .nodes.map((node) => {
    if (node.type === 'atrule' && node.name === 'custom-media') {
      const [_match, name, params] = node.params.match(/--(\w+)\s+(.+)/);
      return { name, params };
    }

    return null;
  })
  .filter(Boolean);

module.exports = () => ({
  postcssPlugin: 'postcss-workds',
  AtRule(atrule) {
    if (atrule.name === 'breakpoints') {
      atrule.name = 'media all';

      breakpoints.forEach((breakpoint) => {
        const media = new postcss.AtRule({
          name: 'media',
          params: breakpoint.params,
        });

        atrule.each((child) => {
          const clone = child.clone();
          addPrefix(clone, breakpoint.name);
          media.append(clone);
        });

        atrule.parent.append(media);
      });
    }
  },
});

module.exports.postcss = true;

function addPrefix(node, prefix) {
  if (node.type === 'atrule') {
    node.each((child) => addPrefix(child, prefix));
  }

  /**
   * Should match responsive classes (rt-r- prefix):
   * ```
   * .rt-r-size-1
   * .rt-r-m-2
   * .-rt-r-m-2
   * .rt-Button.rt-r-size-1 (captures "rt-r-size-1")
   * ```
   *
   * Should not match:
   * .rt-Button
   */
  const classNameRegexp = /\.(-?rt-r-[a-z0-9-]+)/g;

  // Check for rules that use compound props on a component:
  // - a component name (prefixed with "rt-" and pascal cased)
  // - followed by 2 or more prop selectors (lowercase, numbers, -)
  //
  // e.g. ".rt-DialogContent.rt-r-size-2.gray"
  if (/\.rt-(?:[A-Z][a-z]+)+(?:\.[a-z0-9-]+){2,}/.test(node.selector)) {
    throw Error(`
      "${node.selector}" looks like it uses compound props on a component.
      "@breakpoints" does not support compound props yet.
    `);
  }

  if (classNameRegexp.test(node.selector)) {
    node.selector = node.selector.replace(classNameRegexp, `.${prefix}\\:$1`);
  }
}

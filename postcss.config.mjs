// postcss-workds went with the vendored design system (ENT-6762): it compiled
// WorkDS's own `@breakpoints` at-rule, which nothing in app/ emits now.
const config = {
  plugins: {
    "postcss-import": {},
    "postcss-hover-media-feature": {},
    "postcss-custom-media": {},
  },
};

export default config;

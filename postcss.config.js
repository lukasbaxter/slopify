// Every `:hover` rule is served only where hovering exists. Touch screens
// (iPad on the desktop layout) otherwise get WebKit's hover emulation: a
// first tap "hovers" a row or card, and when that hover reveals something
// (the play button) the tap is swallowed, so everything needed a double tap.
function hoverMedia() {
  return {
    postcssPlugin: 'hover-media',
    Once(root, { AtRule }) {
      root.walkRules((rule) => {
        if (!rule.selector.includes(':hover')) return;
        if (rule.parent?.type === 'atrule' && /hover/.test(rule.parent.params || '')) return;
        const hov = rule.selectors.filter((s) => s.includes(':hover'));
        const rest = rule.selectors.filter((s) => !s.includes(':hover'));
        const mq = new AtRule({ name: 'media', params: '(hover: hover)' });
        mq.append(rule.clone({ selectors: hov }));
        if (rest.length) { rule.selectors = rest; rule.after(mq); } else rule.replaceWith(mq);
      });
    },
  };
}
hoverMedia.postcss = true;

export default { plugins: [hoverMedia()] };

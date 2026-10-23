/**
 * The body attribute that tells `public/index.html` the document it frames is
 * the public pay route.
 *
 * The frame rules live in the document, so they survive the first paint (before
 * any JS runs); the route is only known to the app. `PayLinkApp` sets this while
 * it is mounted. The CSS uses it for one thing: keeping the phone-width column
 * on a desktop browser, where every other route widens to the whole window for
 * the DesktopGate that the pay route does not have.
 */
export const PAY_LINK_BODY_ATTRIBUTE = "data-nuri-pay-link";

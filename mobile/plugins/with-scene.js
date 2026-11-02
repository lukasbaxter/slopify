// iOS scene lifecycle. Apps built with the iOS 27 SDK must adopt it or they
// do not launch at all ("UIScene life cycle is required for apps built with
// this SDK"), and Expo's generated AppDelegate still makes its own window.
// This moves the window into a SceneDelegate: the React Native factory is
// made at launch as before and started in the scene's window.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const WINDOW_BLOCK = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif/;

const SCENE_DELEGATE = `
// The app's one window, made by its scene (plugins/with-scene.js).
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let app = UIApplication.shared.delegate as? AppDelegate,
          let factory = app.reactNativeFactory else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    app.window = window
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: app.launchOptions)
  }
}
`;

module.exports = function withScene(config) {
  config = withAppDelegate(config, (c) => {
    let src = c.modResults.contents;
    if (c.modResults.language !== 'swift' || src.includes('class SceneDelegate')) return c;
    if (!WINDOW_BLOCK.test(src)) throw new Error('with-scene: AppDelegate.swift no longer has the window block this plugin replaces; update plugins/with-scene.js');
    src = src.replace(WINDOW_BLOCK, '    // The window comes from SceneDelegate (plugins/with-scene.js).\n    self.launchOptions = launchOptions');
    src = src.replace('  var reactNativeFactory: RCTReactNativeFactory?\n', '  var reactNativeFactory: RCTReactNativeFactory?\n  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n');
    if (!src.includes('var launchOptions')) throw new Error('with-scene: could not add launchOptions to AppDelegate');
    c.modResults.contents = `${src.trimEnd()}\n${SCENE_DELEGATE}`;
    return c;
  });
  return withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: 'Default', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate' }],
      },
    };
    return c;
  });
};

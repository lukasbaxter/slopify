// Android: the system's media session for the music in the WebView (see
// android/.../SlopifyMediaService.kt). Null on iOS, where WKWebView has
// navigator.mediaSession itself.
import { requireOptionalNativeModule } from 'expo-modules-core';

export default requireOptionalNativeModule('SlopifyMedia');

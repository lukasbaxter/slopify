// mrctl: talk to MediaRemote inside an iOS Simulator, the way the lock screen
// and Control Center do. Built for the simulator SDK by ios-sim.sh and run
// with `xcrun simctl spawn <udid> mrctl ...`.
//
//   mrctl info [artwork.out]  print the system Now Playing info as JSON
//                             (title, artist, album, duration, elapsed, rate,
//                             isPlaying, app); optionally save the artwork bytes
//   mrctl play|pause|toggle|stop|next|prev|skipfwd|skipback
//   mrctl seek <seconds>      ChangePlaybackPosition (MediaSession "seekto")
//
// MediaRemote is private; the functions are looked up with dlsym so the tool
// builds against the public SDK.
#import <Foundation/Foundation.h>
#import <dlfcn.h>

typedef void (*GetInfoFn)(dispatch_queue_t, void (^)(CFDictionaryRef));
typedef void (*GetIsPlayingFn)(dispatch_queue_t, void (^)(Boolean));
typedef void (*GetClientFn)(dispatch_queue_t, void (^)(id));
typedef Boolean (*SendCmdFn)(int, CFDictionaryRef);

static void *MR;
static void *sym(const char *n) { void *p = dlsym(MR, n); if (!p) { fprintf(stderr, "missing %s\n", n); exit(2); } return p; }

static id jsonable(id v) {
  if ([v isKindOfClass:NSDate.class]) return @([(NSDate *)v timeIntervalSince1970]);
  if ([v isKindOfClass:NSData.class]) return [NSString stringWithFormat:@"<%lu bytes>", (unsigned long)[(NSData *)v length]];
  if ([v isKindOfClass:NSString.class] || [v isKindOfClass:NSNumber.class]) return v;
  return [v description];
}

int main(int argc, char **argv) {
  @autoreleasepool {
    MR = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
    if (!MR) { fprintf(stderr, "dlopen MediaRemote failed: %s\n", dlerror()); return 2; }
    if (argc < 2) { fprintf(stderr, "usage: mrctl info [art.out] | play|pause|toggle|stop|next|prev|skipfwd|skipback | seek <s>\n"); return 2; }
    NSString *cmd = @(argv[1]);
    dispatch_queue_t q = dispatch_get_main_queue();
    if ([cmd isEqualToString:@"info"]) {
      __block int pending = 3;
      NSMutableDictionary *out = [NSMutableDictionary new];
      NSString *artPath = argc > 2 ? @(argv[2]) : nil;
      void (^done)(void) = ^{ if (--pending == 0) {
        NSData *j = [NSJSONSerialization dataWithJSONObject:out options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
        printf("%s\n", j.bytes ? [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding].UTF8String : "{}");
        exit(0); } };
      ((GetInfoFn)sym("MRMediaRemoteGetNowPlayingInfo"))(q, ^(CFDictionaryRef d) {
        NSDictionary *info = (__bridge NSDictionary *)d;
        NSMutableDictionary *m = [NSMutableDictionary new];
        for (NSString *k in info) {
          NSString *short_ = [k stringByReplacingOccurrencesOfString:@"kMRMediaRemoteNowPlayingInfo" withString:@""];
          id v = info[k];
          if ([k hasSuffix:@"ArtworkData"] && [v isKindOfClass:NSData.class] && artPath) [(NSData *)v writeToFile:artPath atomically:YES];
          m[short_] = jsonable(v);
        }
        out[@"info"] = m; done(); });
      ((GetIsPlayingFn)sym("MRMediaRemoteGetNowPlayingApplicationIsPlaying"))(q, ^(Boolean p) { out[@"isPlaying"] = @(p); done(); });
      ((GetClientFn)sym("MRMediaRemoteGetNowPlayingClient"))(q, ^(id c) {
        SEL b = NSSelectorFromString(@"bundleIdentifier"), pb = NSSelectorFromString(@"parentApplicationBundleIdentifier");
        if (c && [c respondsToSelector:b]) out[@"client"] = [c performSelector:b] ?: [NSNull null];
        if (c && [c respondsToSelector:pb]) out[@"parentApp"] = [c performSelector:pb] ?: [NSNull null];
        done(); });
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), q, ^{ fprintf(stderr, "timeout\n"); exit(3); });
      dispatch_main();
    }
    NSDictionary *cmds = @{ @"play": @0, @"pause": @1, @"toggle": @2, @"stop": @3, @"next": @4, @"prev": @5,
                            @"skipfwd": @17, @"skipback": @18, @"seek": @24 };
    NSNumber *c = cmds[cmd];
    if (!c) { fprintf(stderr, "unknown command %s\n", argv[1]); return 2; }
    NSDictionary *opts = nil;
    if ([cmd isEqualToString:@"seek"]) {
      if (argc < 3) { fprintf(stderr, "seek needs seconds\n"); return 2; }
      // The framework's own key (its value is not its name on every release:
      // with the name as a literal the option was dropped, "options = <not
      // included>", and the app reported the seek as failed).
      CFStringRef *key = (CFStringRef *)dlsym(MR, "kMRMediaRemoteOptionPlaybackPosition");
      opts = @{ (key ? (__bridge NSString *)*key : @"kMRMediaRemoteOptionPlaybackPosition"): @(atof(argv[2])) };
    }
    Boolean ok = ((SendCmdFn)sym("MRMediaRemoteSendCommand"))(c.intValue, (__bridge CFDictionaryRef)opts);
    printf("sent %s (%d): %s\n", argv[1], c.intValue, ok ? "ok" : "FAILED");
    // give the XPC message time to leave before the process exits
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.5]];
    return ok ? 0 : 1;
  }
}

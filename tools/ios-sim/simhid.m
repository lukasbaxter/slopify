// simhid: inject hardware events into a booted simulator from the Mac side,
// the way Simulator.app does (CoreSimulator + SimulatorKit's Indigo HID
// messages), without Simulator.app or anything on screen.
//
//   simhid <udid> lock          press + release the side (lock) button
//   simhid <udid> home          home button (wakes / unlocks a passcode-less sim)
//   simhid <udid> tap <x> <y>   tap at screen points (iPhone 17: 402x874)
//
// Both frameworks are private; everything is resolved at runtime.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <objc/message.h>

typedef void *IndigoMsg;
typedef IndigoMsg (*ButtonFn)(int source, int direction, int target);
typedef IndigoMsg (*MouseFn)(CGPoint *p0, CGPoint *p1, int target, int eventType, CGSize size, int edge);

enum { SrcHome = 0x0, SrcLock = 0x1, SrcSide = 0xbb8, Down = 1, Up = 2, TargetHardware = 0x33, TargetDigitizer = 0x32 };

static id hid;

static void sendMsg(IndigoMsg m) {
  if (!m) { fprintf(stderr, "null indigo message\n"); exit(2); }
  dispatch_semaphore_t s = dispatch_semaphore_create(0);
  __block NSError *err = nil;
  void (^done)(NSError *) = ^(NSError *e) { err = e; dispatch_semaphore_signal(s); };
  ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(hid, NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:"),
                                                                       m, YES, dispatch_get_global_queue(0, 0), done);
  dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
  if (err) { fprintf(stderr, "send failed: %s\n", err.description.UTF8String); exit(1); }
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 3) { fprintf(stderr, "usage: simhid <udid> lock|home|side|tap x y\n"); return 2; }
    NSString *dev = [NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"] ?: @"/Applications/Xcode.app/Contents/Developer" copy];
    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) { fprintf(stderr, "%s\n", dlerror()); return 2; }
    NSString *skPath = [[dev stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"];
    void *sk = dlopen(skPath.UTF8String, RTLD_NOW);
    if (!sk) { fprintf(stderr, "%s\n", dlerror()); return 2; }
    NSError *e = nil;
    id ctx = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(NSClassFromString(@"SimServiceContext"), NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"), dev, &e);
    id set = ((id (*)(id, SEL, NSError **))objc_msgSend)(ctx, NSSelectorFromString(@"defaultDeviceSetWithError:"), &e);
    id device = nil;
    for (id d in [set valueForKey:@"devices"]) if ([[[d valueForKey:@"UDID"] UUIDString] isEqualToString:@(argv[1])]) device = d;
    if (!device) { fprintf(stderr, "device %s not found (%s)\n", argv[1], e.description.UTF8String); return 2; }
    Class C = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
    hid = ((id (*)(id, SEL, id, NSError **))objc_msgSend)([C alloc], NSSelectorFromString(@"initWithDevice:error:"), device, &e);
    if (!hid) { fprintf(stderr, "hid client: %s\n", e.description.UTF8String); return 2; }
    NSString *cmd = @(argv[2]);
    ButtonFn button = (ButtonFn)dlsym(sk, "IndigoHIDMessageForButton");
    if ([cmd isEqualToString:@"lock"] || [cmd isEqualToString:@"side"] || [cmd isEqualToString:@"home"]) {
      int src = [cmd isEqualToString:@"home"] ? SrcHome : [cmd isEqualToString:@"side"] ? SrcSide : SrcLock;
      sendMsg(button(src, Down, TargetHardware));
      usleep(80 * 1000);
      sendMsg(button(src, Up, TargetHardware));
    } else if (([cmd isEqualToString:@"tap"] && argc >= 5) || ([cmd isEqualToString:@"swipe"] && argc >= 7)) {
      // Indigo digitizer points are 0..1 ratios of the screen.
      id screen = nil;
      CGSize sz = CGSizeMake(402, 874);
      @try { screen = [[device valueForKey:@"deviceType"] valueForKey:@"mainScreenSize"]; } @catch (id x) {}
      double scale = 3;
      @try { scale = [[[device valueForKey:@"deviceType"] valueForKey:@"mainScreenScale"] doubleValue] ?: 3; } @catch (id x) {}
      if (screen) { NSSize px = [screen sizeValue]; sz = CGSizeMake(px.width / scale, px.height / scale); }
      CGPoint p = CGPointMake(atof(argv[3]) / sz.width, atof(argv[4]) / sz.height);
      MouseFn mouse = (MouseFn)dlsym(sk, "IndigoHIDMessageForMouseNSEvent");
      sendMsg(mouse(&p, NULL, TargetDigitizer, NSEventTypeLeftMouseDown, CGSizeMake(1, 1), 0));
      if ([cmd isEqualToString:@"swipe"]) {
        // swipe x1 y1 x2 y2: drag in 12 steps over ~240 ms
        CGPoint q = CGPointMake(atof(argv[5]) / sz.width, atof(argv[6]) / sz.height);
        for (int i = 1; i <= 12; i++) {
          usleep(20 * 1000);
          p = CGPointMake(p.x + (q.x - p.x) / (13 - i), p.y + (q.y - p.y) / (13 - i));
          sendMsg(mouse(&p, NULL, TargetDigitizer, NSEventTypeLeftMouseDragged, CGSizeMake(1, 1), 0));
        }
      } else usleep(60 * 1000);
      sendMsg(mouse(&p, NULL, TargetDigitizer, NSEventTypeLeftMouseUp, CGSizeMake(1, 1), 0));
    } else { fprintf(stderr, "unknown command\n"); return 2; }
    printf("ok %s\n", argv[2]);
    return 0;
  }
}

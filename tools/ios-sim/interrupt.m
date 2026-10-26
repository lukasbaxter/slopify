// interrupt: another app taking the audio, as Snapchat or a video would.
// Runs inside the simulator (simctl spawn): activates a non-mixable
// playback audio session, plays silence for N seconds, then deactivates
// with notifyOthersOnDeactivation (what makes iOS tell the interrupted app
// "interruption ended, you may resume").
//
//   interrupt [seconds=5] [--no-notify]
#import <Foundation/Foundation.h>
#import <AVFAudio/AVFAudio.h>

int main(int argc, char **argv) {
  @autoreleasepool {
    double secs = argc > 1 ? atof(argv[1]) : 5;
    BOOL notify = !(argc > 2 && strcmp(argv[2], "--no-notify") == 0);
    AVAudioSession *s = [AVAudioSession sharedInstance];
    NSError *e = nil;
    if (![s setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeDefault options:0 error:&e]) { fprintf(stderr, "category: %s\n", e.description.UTF8String); return 1; }
    if (![s setActive:YES error:&e]) { fprintf(stderr, "activate: %s\n", e.description.UTF8String); return 1; }
    printf("audio session active (playback, not mixable)\n"); fflush(stdout);
    // One second of silence, looped: a real player, so the session is in use.
    AVAudioFormat *fmt = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:44100 channels:2];
    AVAudioEngine *engine = [AVAudioEngine new];
    AVAudioPlayerNode *node = [AVAudioPlayerNode new];
    [engine attachNode:node];
    [engine connect:node to:engine.mainMixerNode format:fmt];
    AVAudioPCMBuffer *buf = [[AVAudioPCMBuffer alloc] initWithPCMFormat:fmt frameCapacity:44100];
    buf.frameLength = 44100; // zeros: silence
    if (![engine startAndReturnError:&e]) { fprintf(stderr, "engine: %s\n", e.description.UTF8String); return 1; }
    [node scheduleBuffer:buf atTime:nil options:AVAudioPlayerNodeBufferLoops completionHandler:nil];
    [node play];
    printf("playing silence for %.1f s\n", secs); fflush(stdout);
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:secs]];
    [node stop]; [engine stop];
    if (![s setActive:NO withOptions:(notify ? AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation : 0) error:&e]) { fprintf(stderr, "deactivate: %s\n", e.description.UTF8String); return 1; }
    printf("audio session released%s\n", notify ? " (others notified)" : ""); fflush(stdout);
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.5]];
    return 0;
  }
}

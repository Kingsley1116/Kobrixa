#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <bsm/libbsm.h>
#import <mach/mach.h>
#import <unistd.h>

static void later(void (^callback)(void)) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), callback);
}

int main(void) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSWindow *window =
        [[NSWindow alloc] initWithContentRect:NSMakeRect(50, 50, 220, 100)
                                    styleMask:NSWindowStyleMaskTitled
                                      backing:NSBackingStoreBuffered
                                        defer:NO];
    window.title = @"Kobrixa W17 window probe";
    [app finishLaunching];
    [app activateIgnoringOtherApps:YES];
    [window makeKeyAndOrderFront:nil];
    later(^{
      BOOL visible = window.isVisible;
      BOOL focused = window.isKeyWindow;
      [window orderOut:nil];
      later(^{
        BOOL defocused = !window.isKeyWindow;
        [app activateIgnoringOtherApps:YES];
        [window makeKeyAndOrderFront:nil];
        later(^{
          NSDictionary *session =
              CFBridgingRelease(CGSessionCopyCurrentDictionary());
          NSArray *windows = CFBridgingRelease(
              CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
                                         (CGWindowID)window.windowNumber));
          NSDictionary *entry = windows.firstObject;
          audit_token_t token;
          mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
          kern_return_t kr = task_info(mach_task_self(), TASK_AUDIT_TOKEN,
                                       (task_info_t)&token, &count);
          NSDictionary *report = @{
            @"pid" : @(getpid()),
            @"uid" : @(geteuid()),
            @"asid" : kr == KERN_SUCCESS ? @(audit_token_to_asid(token))
                                         : NSNull.null,
            @"sessionUID" : session[(id)kCGSessionUserIDKey] ?: NSNull.null,
            @"loggedIn" : session[(id)kCGSessionLoginDoneKey] ?: NSNull.null,
            @"window" : @(window.windowNumber),
            @"visible" : @(visible),
            @"ownerPID" : entry[(id)kCGWindowOwnerPID] ?: NSNull.null,
            @"focused" : @(focused),
            @"defocused" : @(defocused),
            @"refocused" : @(window.isKeyWindow),
            @"callback" : @YES
          };
          NSData *json = [NSJSONSerialization dataWithJSONObject:report
                                                         options:0
                                                           error:nil];
          fwrite(json.bytes, 1, json.length, stdout);
          puts("");
          fflush(stdout);
          [app terminate:nil];
        });
      });
    });
    [app run];
  }
  return 0;
}

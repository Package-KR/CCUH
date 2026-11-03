#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static const NSUInteger WindowLimit = 256;
static const uint32_t DisplayLimit = 64;

// 유효한 화면 좌표 판별
static BOOL validBounds(CGRect bounds) {
  return isfinite(bounds.origin.x) && isfinite(bounds.origin.y) &&
         isfinite(bounds.size.width) && isfinite(bounds.size.height) &&
         bounds.size.width > 0 && bounds.size.height > 0;
}

// 전역 화면 좌표 직렬화
static NSDictionary *serializeBounds(CGRect bounds) {
  return @{
    @"x": @(bounds.origin.x),
    @"y": @(bounds.origin.y),
    @"width": @(bounds.size.width),
    @"height": @(bounds.size.height)
  };
}

// 연결된 화면의 배율 조회
static NSDictionary<NSNumber *, NSNumber *> *displayScales(void) {
  NSMutableDictionary<NSNumber *, NSNumber *> *scales = [NSMutableDictionary dictionary];
  for (NSScreen *screen in NSScreen.screens) {
    NSNumber *identifier = screen.deviceDescription[@"NSScreenNumber"];
    CGFloat scale = screen.backingScaleFactor;
    if ([identifier isKindOfClass:NSNumber.class] && isfinite(scale) && scale > 0) {
      scales[identifier] = @(scale);
    }
  }
  return scales;
}

// 활성 디스플레이 배치 관측
static NSDictionary *observeDisplays(void) {
  uint32_t requestedCount = 0;
  CGError countResult = CGGetActiveDisplayList(0, NULL, &requestedCount);
  if (countResult != kCGErrorSuccess || requestedCount > DisplayLimit) {
    return @{@"status": @"unavailable", @"items": NSNull.null};
  }
  if (requestedCount == 0) {
    return @{@"status": @"observed", @"items": @[]};
  }
  CGDirectDisplayID *identifiers = calloc(requestedCount, sizeof(CGDirectDisplayID));
  if (identifiers == NULL) {
    return @{@"status": @"unavailable", @"items": NSNull.null};
  }
  uint32_t returnedCount = 0;
  CGError listResult = CGGetActiveDisplayList(requestedCount, identifiers, &returnedCount);
  uint32_t verifiedCount = 0;
  CGError verifyResult = CGGetActiveDisplayList(0, NULL, &verifiedCount);
  if (listResult != kCGErrorSuccess || verifyResult != kCGErrorSuccess ||
      returnedCount != requestedCount || verifiedCount != requestedCount) {
    free(identifiers);
    return @{@"status": @"unavailable", @"items": NSNull.null};
  }
  CGDirectDisplayID primary = CGMainDisplayID();
  NSDictionary<NSNumber *, NSNumber *> *scales = displayScales();
  NSMutableArray<NSDictionary *> *items = [NSMutableArray arrayWithCapacity:returnedCount];
  NSMutableSet<NSNumber *> *seen = [NSMutableSet setWithCapacity:returnedCount];
  BOOL valid = YES;
  for (uint32_t index = 0; index < returnedCount; index++) {
    CGDirectDisplayID identifier = identifiers[index];
    NSNumber *key = @(identifier);
    CGRect bounds = CGDisplayBounds(identifier);
    if (identifier == kCGNullDirectDisplay || [seen containsObject:key] || !validBounds(bounds)) {
      valid = NO;
      break;
    }
    [seen addObject:key];
    [items addObject:@{
      @"id": key,
      @"bounds": serializeBounds(bounds),
      @"isPrimary": [NSNumber numberWithBool:identifier == primary],
      @"isBuiltIn": [NSNumber numberWithBool:CGDisplayIsBuiltin(identifier) != 0],
      @"backingScaleFactor": scales[key] ?: NSNull.null
    }];
  }
  free(identifiers);
  return valid ? @{@"status": @"observed", @"items": items}
               : @{@"status": @"unavailable", @"items": NSNull.null};
}

// 창과 겹치는 디스플레이 식별자 조회
static id intersectingDisplays(CGRect windowBounds, NSDictionary *displays) {
  if (![displays[@"status"] isEqual:@"observed"]) return NSNull.null;
  NSMutableArray<NSNumber *> *identifiers = [NSMutableArray array];
  for (NSDictionary *display in displays[@"items"]) {
    NSDictionary *value = display[@"bounds"];
    CGRect bounds = CGRectMake([value[@"x"] doubleValue], [value[@"y"] doubleValue],
                               [value[@"width"] doubleValue], [value[@"height"] doubleValue]);
    CGRect intersection = CGRectIntersection(windowBounds, bounds);
    if (!CGRectIsNull(intersection) && !CGRectIsEmpty(intersection)) {
      [identifiers addObject:display[@"id"]];
    }
  }
  return identifiers;
}

// 실행 중 앱의 번들 식별자 조회
static id bundleIdentifierForPID(pid_t pid) {
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  return application.bundleIdentifier ?: NSNull.null;
}

// 현재 화면의 일반 창 배치 관측
static NSDictionary *observeWindows(NSDictionary *displays, BOOL screenCaptureAccess) {
  NSArray<NSDictionary *> *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  if (windows == nil) {
    return @{
      @"status": @"unavailable", @"scope": @"on-screen-normal-layer",
      @"items": NSNull.null, @"truncated": @NO
    };
  }
  BOOL truncated = NO;
  BOOL incomplete = !screenCaptureAccess || ![displays[@"status"] isEqual:@"observed"];
  NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
  NSMutableSet<NSNumber *> *seen = [NSMutableSet set];
  NSUInteger order = 0;
  for (NSDictionary *window in windows) {
    NSUInteger zOrder = order++;
    NSNumber *layer = window[(id)kCGWindowLayer];
    NSNumber *alpha = window[(id)kCGWindowAlpha];
    if (![layer isKindOfClass:NSNumber.class] || ![alpha isKindOfClass:NSNumber.class]) {
      incomplete = YES;
      continue;
    }
    if (!isfinite(alpha.doubleValue)) {
      incomplete = YES;
      continue;
    }
    if (layer.integerValue != 0 || alpha.doubleValue <= 0) continue;
    NSNumber *identifier = window[(id)kCGWindowNumber];
    NSNumber *ownerPID = window[(id)kCGWindowOwnerPID];
    NSDictionary *value = window[(id)kCGWindowBounds];
    CGRect bounds = CGRectNull;
    if (![identifier isKindOfClass:NSNumber.class] || identifier.unsignedLongLongValue == 0 ||
        identifier.unsignedLongLongValue > UINT32_MAX ||
        ![ownerPID isKindOfClass:NSNumber.class] || ownerPID.longLongValue <= 0 ||
        ownerPID.longLongValue > INT32_MAX || ![value isKindOfClass:NSDictionary.class] ||
        !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value, &bounds) ||
        !validBounds(bounds) || [seen containsObject:identifier]) {
      incomplete = YES;
      continue;
    }
    if (items.count == WindowLimit) {
      truncated = YES;
      break;
    }
    [seen addObject:identifier];
    pid_t pid = ownerPID.intValue;
    [items addObject:@{
      @"id": identifier,
      @"pid": ownerPID,
      @"bundleIdentifier": bundleIdentifierForPID(pid),
      @"bounds": serializeBounds(bounds),
      @"displayIds": intersectingDisplays(bounds, displays),
      @"zOrder": @(zOrder)
    }];
  }
  return @{
    @"status": incomplete || truncated ? @"partial" : @"observed",
    @"scope": @"on-screen-normal-layer",
    @"items": items,
    @"truncated": @(truncated)
  };
}

// 현재 앞에 있는 앱의 식별자 관측
static NSDictionary *observeForegroundApplication(void) {
  NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (application == nil || application.processIdentifier <= 0) {
    return @{@"status": @"unknown", @"value": NSNull.null};
  }
  return @{
    @"status": @"observed",
    @"value": @{
      @"pid": @(application.processIdentifier),
      @"bundleIdentifier": application.bundleIdentifier ?: NSNull.null
    }
  };
}

// 환경 메타데이터 단회 구성
static NSDictionary *observeEnvironment(void) {
  NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                            NSISO8601DateFormatWithFractionalSeconds;
  NSString *capturedAt = [formatter stringFromDate:NSDate.date];
  BOOL screenCaptureAccess = CGPreflightScreenCaptureAccess();
  NSDictionary *displays = observeDisplays();
  return @{
    @"schemaVersion": @1,
    @"capturedAt": capturedAt,
    @"coordinateSpace": @"quartz-global-screen-coordinates",
    @"screenCaptureAccess": screenCaptureAccess ? @"granted" : @"not-granted",
    @"displays": displays,
    @"windows": observeWindows(displays, screenCaptureAccess),
    @"foregroundApplication": observeForegroundApplication(),
    @"unsupported": @[@"spaces", @"fullscreen", @"browser-window-tab-mapping"]
  };
}

// 관측 결과 JSON 단회 출력
int main(void) {
  @autoreleasepool {
    @try {
      NSData *data = [NSJSONSerialization dataWithJSONObject:observeEnvironment() options:0 error:NULL];
      if (data == nil || fwrite(data.bytes, 1, data.length, stdout) != data.length ||
          fputc('\n', stdout) == EOF) {
        fputs("CCUH: environment observation unavailable\n", stderr);
        return 1;
      }
      return 0;
    } @catch (__unused NSException *exception) {
      fputs("CCUH: environment observation unavailable\n", stderr);
      return 1;
    }
  }
}

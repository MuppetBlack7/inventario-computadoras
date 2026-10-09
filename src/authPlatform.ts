export interface NavigatorPlatformInfo {
  userAgent: string
  platform: string
  maxTouchPoints: number
}

export function isAppleMobilePlatform(info: NavigatorPlatformInfo) {
  return /iPad|iPhone|iPod/.test(info.userAgent)
    || (info.platform === 'MacIntel' && info.maxTouchPoints > 1)
}

import type { ReactNode } from 'react'

interface IconProps {
  className?: string
}

const IconFrame = ({ className, children }: IconProps & { children: ReactNode }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const LayoutGridIcon = ({ className }: IconProps) => <IconFrame className={className}>
  <rect width="7" height="7" x="3" y="3" rx="1" />
  <rect width="7" height="7" x="14" y="3" rx="1" />
  <rect width="7" height="7" x="3" y="14" rx="1" />
  <rect width="7" height="7" x="14" y="14" rx="1" />
</IconFrame>

export const ScanLineIcon = ({ className }: IconProps) => <IconFrame className={className}>
  <path d="M3 7V5a2 2 0 0 1 2-2h2" />
  <path d="M17 3h2a2 2 0 0 1 2 2v2" />
  <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
  <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
  <path d="M7 12h10" />
</IconFrame>

export const RefreshCwIcon = ({ className }: IconProps) => <IconFrame className={className}>
  <path d="M21 12a9 9 0 0 0-15.5-6.2L3 8" />
  <path d="M3 3v5h5" />
  <path d="M3 12a9 9 0 0 0 15.5 6.2L21 16" />
  <path d="M16 16h5v5" />
</IconFrame>

export const DatabaseBackupIcon = ({ className }: IconProps) => <IconFrame className={className}>
  <ellipse cx="12" cy="5" rx="7" ry="3" />
  <path d="M5 5v6c0 1.7 3.1 3 7 3 .7 0 1.4 0 2-.1" />
  <path d="M5 11v6c0 1.7 3.1 3 7 3" />
  <path d="m17 16 2 2 2-2" />
  <path d="M19 13v5" />
</IconFrame>

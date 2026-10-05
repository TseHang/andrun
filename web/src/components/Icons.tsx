// Small line icons, 14 px by default, drawn in the current text colour.
import type { ReactNode } from "react";

function Icon({ size = 14, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

export const EyeIcon = () => (
  <Icon>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Icon>
);

export const DownloadIcon = () => (
  <Icon>
    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
  </Icon>
);

export const ExpandIcon = () => (
  <Icon>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </Icon>
);

export const CollapseIcon = () => (
  <Icon>
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />
  </Icon>
);

export const ReloadIcon = () => (
  <Icon>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Icon>
);

/** The side panel: a window with its right column marked. */
export const PanelIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M10 3v10" />
  </Icon>
);

export const PlanIcon = () => (
  <Icon>
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.5 4l.8.8L4.8 3.2M2.5 8l.8.8 1.5-1.6M2.7 12h1.6" />
  </Icon>
);

export const PullRequestIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="4" cy="3.5" r="1.5" />
    <circle cx="4" cy="12.5" r="1.5" />
    <circle cx="12" cy="12.5" r="1.5" />
    <path d="M4 5v6M12 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />
  </Icon>
);

export const FileIcon = () => (
  <Icon>
    <path d="M9 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5z" />
    <path d="M9 2v3.5h3.5" />
  </Icon>
);

export const BoxIcon = () => (
  <Icon>
    <path d="M8 1.75 13.5 4.5v7L8 14.25 2.5 11.5v-7z" />
    <path d="M2.5 4.5 8 7.25l5.5-2.75M8 7.25v7" />
  </Icon>
);

export const GlobeIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75z" />
  </Icon>
);

export const PencilIcon = () => (
  <Icon size={12}>
    <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
  </Icon>
);

export const BranchIcon = () => (
  <Icon size={13}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5" r="1.5" />
    <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" />
  </Icon>
);

export const PlusIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

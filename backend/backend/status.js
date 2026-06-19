import fs from 'fs';
import path from 'path';

export const AGENT_STEPS = [
  { key: 'launching-browser', label: 'Launching browser' },
  { key: 'logging-into-linkedin', label: 'Logging into LinkedIn' },
  { key: 'searching-posts', label: 'Searching posts' },
  { key: 'switching-posts-tab', label: 'Switching to Posts tab' },
  { key: 'scrolling-posts', label: 'Scrolling and loading posts' },
  { key: 'found-posts', label: 'Found posts' },
  { key: 'filtering-posts', label: 'Filtering relevant posts' },
  { key: 'found-emails', label: 'Found emails' },
  { key: 'customizing-email', label: 'Customizing email' },
  { key: 'sending-email', label: 'Sending email' },
  { key: 'done', label: 'Done' }
];

export const STATUS_TOTAL_STEPS = AGENT_STEPS.length;

export function getStatusPath() {
  return path.join(process.cwd(), 'status.json');
}

export function getScreenshotPath() {
  return path.join(process.cwd(), 'screenshot.png');
}

export function writeStatus({
  step,
  stepKey,
  progress,
  total = STATUS_TOTAL_STEPS,
  state = 'active',
  details = {},
  error = null
}) {
  const status = {
    step,
    stepKey,
    progress,
    total,
    state,
    details,
    error,
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(getStatusPath(), JSON.stringify(status, null, 2), 'utf-8');
  return status;
}

export function readStatus() {
  try {
    const statusPath = getStatusPath();
    if (fs.existsSync(statusPath)) {
      return JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    }
  } catch (error) {
    console.error('Failed to read status.json:', error);
  }

  return {
    step: 'Idle',
    stepKey: 'idle',
    progress: 0,
    total: STATUS_TOTAL_STEPS,
    state: 'pending',
    details: {},
    error: null,
    timestamp: new Date().toISOString()
  };
}

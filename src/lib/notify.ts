// Local browser notifications + haptics.
// Web Push (VAPID) can be added later — this handles the "foreground alert" use case.

const PERMISSION_KEY = 'arbor:notification-permission';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  const result = await Notification.requestPermission();
  localStorage.setItem(PERMISSION_KEY, result);
  return result;
}

export function notify(title: string, options: NotificationOptions & { haptic?: 'light' | 'success' | 'error' } = {}) {
  const { haptic, ...rest } = options;
  if (haptic) buzz(haptic);

  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    // If a service worker is registered, use that so notifications persist
    navigator.serviceWorker?.getRegistration().then(reg => {
      if (reg && 'showNotification' in reg) {
        reg.showNotification(title, {
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          ...rest,
        });
      } else {
        new Notification(title, { icon: '/icon-192.png', ...rest });
      }
    });
  } catch { /* ignore */ }
}

export function buzz(kind: 'light' | 'success' | 'error' = 'light') {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try {
    if (kind === 'success') navigator.vibrate([20, 40, 20]);
    else if (kind === 'error') navigator.vibrate([80, 40, 80, 40, 120]);
    else navigator.vibrate(15);
  } catch { /* ignore */ }
}

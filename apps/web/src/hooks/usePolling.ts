import { useEffect, useRef } from 'react';
import { POLLING_INTERVAL_MS } from '@crypto-monitor/shared';

/**
 * 轮询 hook（dev.md 5.2）
 * 页面不可见时暂停
 */
export function usePolling(fn: () => void, interval = POLLING_INTERVAL_MS) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const tick = () => {
      if (document.visibilityState === 'visible') {
        fnRef.current();
      }
    };

    const start = () => {
      if (timer) return;
      tick();
      timer = setInterval(tick, interval);
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!stopped) start();
      } else {
        stop();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [interval]);
}

import { useEffect, useRef } from 'react';
import { Team } from '../../shared/types';
import { createActivityLog, updateSessionLastSeen, createOfflineSyncLog, OfflineSyncSummary } from '../services/appwrite';
import { enqueueLog, getQueue, clearQueue, QueuedLog } from '../services/localStore';
import { HeartbeatPayload } from '../../shared/types';

export function useMonitoring(user: Team | null, isOnline: boolean, currentFile: string) {
  const currentFileRef = useRef(currentFile);
  const isOnlineRef = useRef(isOnline);

  // Keep refs in sync so heartbeat handler always reads latest values
  useEffect(() => {
    isOnlineRef.current = isOnline;
  }, [isOnline]);

  useEffect(() => {
    currentFileRef.current = currentFile;
    if (window.electronAPI?.monitoring) {
      window.electronAPI.monitoring.setCurrentFile(currentFile);
    }
  }, [currentFile]);

  useEffect(() => {
    if (!user) return;

    // Start monitoring
    if (window.electronAPI?.monitoring) {
      window.electronAPI.monitoring.start(user.teamName, user.$id!);
    }

    // Listen to heartbeats from main process
    const eventsAPI = (window as unknown as { electronEvents?: { onHeartbeat: (cb: (p: HeartbeatPayload) => void) => void; onFlushQueue: (cb: (q: HeartbeatPayload[]) => void) => void; removeAllListeners: (ch: string) => void } }).electronEvents;

    if (eventsAPI) {
      eventsAPI.onHeartbeat(async (payload: HeartbeatPayload) => {
        if (isOnlineRef.current) {
          await createActivityLog(payload);
          await updateSessionLastSeen(payload.teamId);
        } else {
          enqueueLog({ type: 'activityLog', payload, queuedAt: new Date().toISOString() });
        }
      });

      eventsAPI.onFlushQueue(async (queue: HeartbeatPayload[]) => {
        for (const item of queue) {
          if (isOnlineRef.current) {
            await createActivityLog(item).catch(() => {});
          }
        }
      });
    }

    return () => {
      if (eventsAPI) {
        eventsAPI.removeAllListeners('monitoring:heartbeat');
        eventsAPI.removeAllListeners('monitoring:flushQueue');
      }
      if (window.electronAPI?.monitoring) {
        window.electronAPI.monitoring.stop();
      }
    };
  }, [user]);

  // Flush offline queue on reconnect — compact into a single summary log
  useEffect(() => {
    if (!isOnline || !user) return;
    const queue = getQueue();
    if (queue.length === 0) return;

    const activityItems = queue.filter((q: QueuedLog) => q.type === 'activityLog');
    if (activityItems.length === 0) { clearQueue(); return; }

    (async () => {
      const payloads = activityItems.map((q) => q.payload as HeartbeatPayload);
      const timestamps = payloads.map((p) => new Date(p.timestamp).getTime());
      const apps = new Set<string>();
      const files = new Set<string>();
      const windows = new Set<string>();
      for (const p of payloads) {
        if (p.appName) apps.add(p.appName);
        if (p.currentFile) files.add(p.currentFile);
        if (p.currentWindow) windows.add(p.currentWindow);
      }

      const summary: OfflineSyncSummary = {
        offlineFrom: new Date(Math.min(...timestamps)).toISOString(),
        offlineTo: new Date(Math.max(...timestamps)).toISOString(),
        duration: Math.max(...timestamps) - Math.min(...timestamps),
        logCount: payloads.length,
        apps: Array.from(apps),
        files: Array.from(files),
        windows: Array.from(windows),
        syncedAt: new Date().toISOString(),
      };

      await createOfflineSyncLog(user.$id!, user.teamName, summary).catch(() => {});
      await updateSessionLastSeen(user.$id!).catch(() => {});
      clearQueue();
    })();
  }, [isOnline, user]);
}

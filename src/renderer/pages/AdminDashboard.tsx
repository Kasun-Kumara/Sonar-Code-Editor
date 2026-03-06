import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { getAllSessions, subscribeToActivityLogs, subscribeToSessions, getAllActivityLogs, getAdminTeamIds, OfflineSyncSummary } from '../services/appwrite';
import { Session, ActivityLog, Team } from '../../shared/types';
import { APP_CONFIG } from '../../shared/constants';
import ReportModal from '../components/AdminPanel/ReportModal';
import './AdminDashboard.css';

interface TeamStatus extends Session {
  currentWindow?: string;
  currentFile?: string;
  lastActivity?: string;
  offlineSync?: OfflineSyncSummary;
}

type SortKey = 'teamName' | 'status' | 'lastSeen';
type SortDir = 'asc' | 'desc';
type ViewMode = 'table' | 'grid';

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const [teams, setTeams] = useState<TeamStatus[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<TeamStatus | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const unsubRefs = useRef<Array<() => void>>([]);
  const adminIdsRef = useRef<Set<string>>(new Set());

  const applyStaleCheck = useCallback((teamsList: TeamStatus[]): TeamStatus[] => {
    const now = Date.now();
    return teamsList.map((s) => {
      const lastSeenMs = new Date(s.lastSeen).getTime();
      const stale = now - lastSeenMs > APP_CONFIG.HEARTBEAT_INTERVAL_MS * 2;
      if (stale && s.status === 'online') return { ...s, status: 'offline' as const };
      return s;
    });
  }, []);

  const loadSessions = useCallback(async () => {
    const [sessions, logs, adminIds] = await Promise.all([
      getAllSessions(),
      getAllActivityLogs(500),
      getAdminTeamIds(),
    ]);
    adminIdsRef.current = adminIds;

    // Build a map of latest offline_sync per team from loaded logs
    const syncMap = new Map<string, OfflineSyncSummary>();
    for (const log of logs) {
      if (log.event === 'offline_sync' && log.windowTitle && !syncMap.has(log.teamId)) {
        try { syncMap.set(log.teamId, JSON.parse(log.windowTitle)); } catch { /* ignore */ }
      }
    }

    const now = Date.now();
    const updated = sessions
      .filter((s) => !adminIds.has(s.teamId))
      .map((s) => {
        const lastSeenMs = new Date(s.lastSeen).getTime();
        const stale = now - lastSeenMs > APP_CONFIG.HEARTBEAT_INTERVAL_MS * 2;
        return {
          ...s,
          status: stale ? 'offline' : s.status,
          offlineSync: syncMap.get(s.teamId),
        } as TeamStatus;
      });
    setTeams(updated);
    setActivityLogs(logs);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSessions();

    const unsubActivity = subscribeToActivityLogs((log: ActivityLog) => {
      if (adminIdsRef.current.has(log.teamId)) return;
      setTeams((prev) => {
        const idx = prev.findIndex((t) => t.teamId === log.teamId);
        if (idx === -1) return prev;
        const updated = [...prev];

        // Parse offline sync summary if available
        let offlineSync: OfflineSyncSummary | undefined;
        if (log.event === 'offline_sync' && log.windowTitle) {
          try { offlineSync = JSON.parse(log.windowTitle); } catch { /* ignore */ }
        }

        updated[idx] = {
          ...updated[idx],
          currentWindow: log.event === 'offline_sync' ? updated[idx].currentWindow : log.currentWindow,
          currentFile: log.event === 'offline_sync' ? updated[idx].currentFile : log.currentFile,
          status: 'online',
          lastSeen: log.timestamp,
          lastActivity: log.timestamp,
          ...(offlineSync ? { offlineSync } : {}),
        };
        return updated;
      });
      setActivityLogs((prev) => [log, ...prev].slice(0, 500));
      setLastUpdated(new Date());
    });

    const unsubSessions = subscribeToSessions((session: Session) => {
      if (adminIdsRef.current.has(session.teamId)) return;
      setTeams((prev) => {
        const idx = prev.findIndex((t) => t.teamId === session.teamId);
        if (idx === -1) return [...prev, session as TeamStatus];
        const updated = [...prev];
        updated[idx] = { ...updated[idx], ...session };
        return updated;
      });
      setLastUpdated(new Date());
    });

    unsubRefs.current = [unsubActivity, unsubSessions];
    const pollInterval = setInterval(loadSessions, 30000);

    // Frequent stale-check: re-evaluate online→offline every 10s based on lastSeen
    const staleCheckInterval = setInterval(() => {
      setTeams((prev) => applyStaleCheck(prev));
    }, 10000);

    return () => {
      unsubRefs.current.forEach((fn) => fn());
      clearInterval(pollInterval);
      clearInterval(staleCheckInterval);
    };
  }, [loadSessions, applyStaleCheck]);

  // Computed metrics
  const onlineCount = teams.filter((t) => t.status === 'online').length;
  const offlineCount = teams.filter((t) => t.status === 'offline').length;
  const onlinePercent = teams.length > 0 ? Math.round((onlineCount / teams.length) * 100) : 0;

  // Team-level activity metrics
  const teamMetrics = useMemo(() => {
    const metrics = new Map<string, {
      totalLogs: number;
      uniqueApps: Set<string>;
      uniqueWindows: Set<string>;
      lastFile: string;
      lastWindow: string;
      firstSeen: string;
      lastSeen: string;
      onlineLogs: number;
      offlineLogs: number;
    }>();

    for (const log of activityLogs) {
      const existing = metrics.get(log.teamId) || {
        totalLogs: 0,
        uniqueApps: new Set<string>(),
        uniqueWindows: new Set<string>(),
        lastFile: '',
        lastWindow: '',
        firstSeen: log.timestamp,
        lastSeen: log.timestamp,
        onlineLogs: 0,
        offlineLogs: 0,
      };

      existing.totalLogs++;
      if (log.appName) existing.uniqueApps.add(log.appName);
      if (log.currentWindow) existing.uniqueWindows.add(log.currentWindow);
      if (!existing.lastFile && log.currentFile) existing.lastFile = log.currentFile;
      if (!existing.lastWindow && log.currentWindow) existing.lastWindow = log.currentWindow;
      if (new Date(log.timestamp) < new Date(existing.firstSeen)) existing.firstSeen = log.timestamp;
      if (new Date(log.timestamp) > new Date(existing.lastSeen)) existing.lastSeen = log.timestamp;
      if (log.status === 'online') existing.onlineLogs++;
      else existing.offlineLogs++;

      metrics.set(log.teamId, existing);
    }
    return metrics;
  }, [activityLogs]);

  // Global activity insights
  const globalInsights = useMemo(() => {
    const uniqueApps = new Set<string>();
    const appCounts = new Map<string, number>();
    let totalOnlineLogs = 0;
    let totalOfflineLogs = 0;

    for (const log of activityLogs) {
      if (log.appName) {
        uniqueApps.add(log.appName);
        appCounts.set(log.appName, (appCounts.get(log.appName) || 0) + 1);
      }
      if (log.status === 'online') totalOnlineLogs++;
      else totalOfflineLogs++;
    }

    const topApps = Array.from(appCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Active teams in last 5 min
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recentlyActive = teams.filter((t) => new Date(t.lastSeen).getTime() > fiveMinAgo).length;

    // Average session duration estimate
    let totalSessionDuration = 0;
    let sessionCount = 0;
    teamMetrics.forEach((m) => {
      const duration = new Date(m.lastSeen).getTime() - new Date(m.firstSeen).getTime();
      if (duration > 0) {
        totalSessionDuration += duration;
        sessionCount++;
      }
    });
    const avgSessionMs = sessionCount > 0 ? totalSessionDuration / sessionCount : 0;

    return {
      totalLogs: activityLogs.length,
      uniqueApps: uniqueApps.size,
      topApps,
      totalOnlineLogs,
      totalOfflineLogs,
      recentlyActive,
      avgSessionMs,
    };
  }, [activityLogs, teams, teamMetrics]);

  // Filtering & sorting
  const filteredTeams = useMemo(() => {
    let result = teams.filter((t) =>
      !search || t.teamName.toLowerCase().includes(search.toLowerCase())
    );
    if (statusFilter !== 'all') {
      result = result.filter((t) => t.status === statusFilter);
    }
    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'teamName') cmp = a.teamName.localeCompare(b.teamName);
      else if (sortKey === 'status') cmp = a.status.localeCompare(b.status);
      else if (sortKey === 'lastSeen') cmp = new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime();
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return result;
  }, [teams, search, statusFilter, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const formatTime = (iso: string) => {
    if (!iso) return '\u2014';
    return new Date(iso).toLocaleTimeString();
  };

  const timeSince = (iso: string) => {
    if (!iso) return '\u2014';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  const formatDuration = (ms: number) => {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return '\u2195';
    return sortDir === 'asc' ? '\u2191' : '\u2193';
  };

  return (
    <div className="admin-container">
      {/* Header */}
      <div className="admin-header">
        <div className="admin-header-left">
          <span className="admin-logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            DevWatch Admin
          </span>
          <span className="admin-live-badge">
            <span className="live-dot" />
            Live
          </span>
        </div>
        <div className="admin-header-right">
          {lastUpdated && (
            <span className="last-updated">Updated {formatTime(lastUpdated.toISOString())}</span>
          )}
          <button className="admin-btn icon-btn" onClick={loadSessions} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
          <span className="admin-user">{user?.teamName}</span>
          <button className="admin-btn danger" onClick={logout}>Sign Out</button>
        </div>
      </div>

      <div className="admin-content">
        {/* Overview Metrics */}
        <div className="admin-metrics-section">
          <div className="metrics-row">
            <div className="stat-card stat-total">
              <div className="stat-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
              <div className="stat-body">
                <span className="stat-value">{teams.length}</span>
                <span className="stat-label">Total Teams</span>
              </div>
            </div>
            <div className="stat-card stat-online">
              <div className="stat-icon online">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
              <div className="stat-body">
                <span className="stat-value online">{onlineCount}</span>
                <span className="stat-label">Online</span>
              </div>
              <div className="stat-bar">
                <div className="stat-bar-fill online" style={{ width: `${onlinePercent}%` }} />
              </div>
            </div>
            <div className="stat-card stat-offline">
              <div className="stat-icon offline">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              </div>
              <div className="stat-body">
                <span className="stat-value offline">{offlineCount}</span>
                <span className="stat-label">Offline</span>
              </div>
              <div className="stat-bar">
                <div className="stat-bar-fill offline" style={{ width: `${teams.length > 0 ? Math.round((offlineCount / teams.length) * 100) : 0}%` }} />
              </div>
            </div>
            <div className="stat-card stat-active">
              <div className="stat-icon accent">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              </div>
              <div className="stat-body">
                <span className="stat-value accent">{globalInsights.recentlyActive}</span>
                <span className="stat-label">Active (5 min)</span>
              </div>
            </div>
            <div className="stat-card stat-session">
              <div className="stat-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div className="stat-body">
                <span className="stat-value">{formatDuration(globalInsights.avgSessionMs)}</span>
                <span className="stat-label">Avg Session</span>
              </div>
            </div>
            <div className="stat-card stat-logs">
              <div className="stat-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              </div>
              <div className="stat-body">
                <span className="stat-value">{globalInsights.totalLogs}</span>
                <span className="stat-label">Activity Logs</span>
              </div>
            </div>
          </div>
        </div>

        {/* Insights Row */}
        <div className="admin-insights-row">
          {/* Online/Offline ratio ring */}
          <div className="insight-card">
            <h3 className="insight-title">Team Status Distribution</h3>
            <div className="donut-chart-container">
              <svg viewBox="0 0 36 36" className="donut-chart">
                <circle cx="18" cy="18" r="15.9155" fill="none" stroke="var(--bg-tertiary)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15.9155" fill="none" stroke="var(--online)" strokeWidth="3"
                  strokeDasharray={`${onlinePercent} ${100 - onlinePercent}`}
                  strokeDashoffset="25" strokeLinecap="round" />
              </svg>
              <div className="donut-center">
                <span className="donut-value">{onlinePercent}%</span>
                <span className="donut-label">Online</span>
              </div>
            </div>
            <div className="insight-legend">
              <div className="legend-item"><span className="legend-dot online" /> Online: {onlineCount}</div>
              <div className="legend-item"><span className="legend-dot offline" /> Offline: {offlineCount}</div>
            </div>
          </div>

          {/* Top Apps */}
          <div className="insight-card">
            <h3 className="insight-title">Top Applications</h3>
            {globalInsights.topApps.length === 0 ? (
              <div className="insight-empty">No app data yet</div>
            ) : (
              <div className="top-apps-list">
                {globalInsights.topApps.map(([app, count]) => {
                  const maxCount = globalInsights.topApps[0][1];
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  const isIDE = app === 'DevWatch IDE';
                  return (
                    <div key={app} className="top-app-item">
                      <div className="top-app-header">
                        <span className={`top-app-name ${isIDE ? '' : 'flagged'}`}>{app}</span>
                        <span className="top-app-count">{count} hits</span>
                      </div>
                      <div className="top-app-bar">
                        <div className={`top-app-bar-fill ${isIDE ? 'ide' : 'non-ide'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="insight-footer">
              <span className="insight-stat">{globalInsights.uniqueApps} unique apps detected</span>
            </div>
          </div>

          {/* Quick Team Health */}
          <div className="insight-card">
            <h3 className="insight-title">Team Health Overview</h3>
            <div className="health-grid">
              {teams.slice(0, 8).map((team) => {
                const m = teamMetrics.get(team.teamId);
                const uptime = m ? Math.round((m.onlineLogs / (m.totalLogs || 1)) * 100) : 0;
                const healthColor = uptime >= 80 ? 'var(--online)' : uptime >= 50 ? 'var(--warning)' : 'var(--offline)';
                return (
                  <div key={team.teamId} className="health-item" title={`${team.teamName}: ${uptime}% uptime`}>
                    <div className="health-avatar" style={{ borderColor: healthColor }}>
                      {team.teamName.charAt(0).toUpperCase()}
                    </div>
                    <span className="health-name">{team.teamName}</span>
                    <span className="health-pct" style={{ color: healthColor }}>{uptime}%</span>
                  </div>
                );
              })}
            </div>
            {teams.length > 8 && (
              <div className="insight-footer">
                <span className="insight-stat">+{teams.length - 8} more teams</span>
              </div>
            )}
          </div>
        </div>

        {/* Controls Bar */}
        <div className="admin-controls-bar">
          <div className="controls-left">
            <input
              type="text"
              placeholder="Search teams..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="admin-search-input"
            />
            <div className="filter-group">
              {(['all', 'online', 'offline'] as const).map((f) => (
                <button
                  key={f}
                  className={`filter-btn ${statusFilter === f ? 'active' : ''} ${f}`}
                  onClick={() => setStatusFilter(f)}
                >
                  {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                  {f === 'all' ? ` (${teams.length})` : f === 'online' ? ` (${onlineCount})` : ` (${offlineCount})`}
                </button>
              ))}
            </div>
          </div>
          <div className="controls-right">
            <button
              className={`view-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              title="Table view"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
            </button>
            <button
              className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="Card view"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </button>
          </div>
        </div>

        {/* Teams Content */}
        <div className="admin-table-container">
          {loading ? (
            <div className="admin-loading">
              <div className="loading-spinner" />
              <span>Loading teams...</span>
            </div>
          ) : filteredTeams.length === 0 ? (
            <div className="admin-empty">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <span>No teams match your filters</span>
            </div>
          ) : viewMode === 'table' ? (
            <table className="admin-table">
              <thead>
                <tr>
                  <th className="th-sortable" onClick={() => handleSort('status')}>Status {sortIcon('status')}</th>
                  <th className="th-sortable" onClick={() => handleSort('teamName')}>Team {sortIcon('teamName')}</th>
                  <th>Current Window</th>
                  <th>Current File</th>
                  <th>Apps Used</th>
                  <th>Uptime</th>
                  <th className="th-sortable" onClick={() => handleSort('lastSeen')}>Last Seen {sortIcon('lastSeen')}</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTeams.map((team) => {
                  const m = teamMetrics.get(team.teamId);
                  const uptime = m ? Math.round((m.onlineLogs / (m.totalLogs || 1)) * 100) : 0;
                  return (
                    <tr key={team.teamId} className={`team-row ${team.status === 'online' ? 'row-online' : 'row-offline'}`}>
                      <td>
                        <span className={`status-badge ${team.status}`}>
                          <span className={`status-dot ${team.status}`} />
                          {team.status}
                        </span>
                      </td>
                      <td className="td-name">{team.teamName}</td>
                      <td className="td-window">{team.currentWindow || '\u2014'}</td>
                      <td className="td-file">
                        {team.currentFile ? (
                          <code className="file-path">{team.currentFile.split(/[/\\]/).pop()}</code>
                        ) : '\u2014'}
                      </td>
                      <td className="td-apps">
                        <span className="apps-count">{m?.uniqueApps.size ?? 0}</span>
                      </td>
                      <td>
                        <div className="uptime-cell">
                          <div className="mini-bar">
                            <div
                              className={`mini-bar-fill ${uptime >= 80 ? 'good' : uptime >= 50 ? 'warn' : 'bad'}`}
                              style={{ width: `${uptime}%` }}
                            />
                          </div>
                          <span className="uptime-pct">{uptime}%</span>
                        </div>
                      </td>
                      <td className="td-time">
                        {timeSince(team.lastSeen)}
                        {team.offlineSync && (
                          <span className="sync-badge" title={`Synced offline data: ${formatDuration(team.offlineSync.duration)} offline (${team.offlineSync.logCount} logs, ${team.offlineSync.apps.length} apps)\nOffline: ${new Date(team.offlineSync.offlineFrom).toLocaleTimeString()} - ${new Date(team.offlineSync.offlineTo).toLocaleTimeString()}\nSynced: ${new Date(team.offlineSync.syncedAt).toLocaleTimeString()}`}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                            synced
                          </span>
                        )}
                      </td>
                      <td>
                        <button
                          className="admin-btn small accent"
                          onClick={() => { setSelectedTeam(team); setShowReport(true); }}
                        >
                          Report
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="team-grid">
              {filteredTeams.map((team) => {
                const m = teamMetrics.get(team.teamId);
                const uptime = m ? Math.round((m.onlineLogs / (m.totalLogs || 1)) * 100) : 0;
                return (
                  <div key={team.teamId} className={`team-card ${team.status}`}>
                    <div className="team-card-header">
                      <div className="team-card-avatar" style={{ borderColor: team.status === 'online' ? 'var(--online)' : 'var(--offline)' }}>
                        {team.teamName.charAt(0).toUpperCase()}
                      </div>
                      <div className="team-card-info">
                        <span className="team-card-name">{team.teamName}</span>
                        <span className={`status-badge ${team.status}`}>
                          <span className={`status-dot ${team.status}`} />
                          {team.status}
                        </span>
                      </div>
                    </div>
                    <div className="team-card-metrics">
                      <div className="team-card-metric">
                        <span className="metric-label">Uptime</span>
                        <div className="mini-bar">
                          <div className={`mini-bar-fill ${uptime >= 80 ? 'good' : uptime >= 50 ? 'warn' : 'bad'}`} style={{ width: `${uptime}%` }} />
                        </div>
                        <span className="metric-value">{uptime}%</span>
                      </div>
                      <div className="team-card-metric">
                        <span className="metric-label">Apps</span>
                        <span className="metric-value">{m?.uniqueApps.size ?? 0}</span>
                      </div>
                      <div className="team-card-metric">
                        <span className="metric-label">Activity</span>
                        <span className="metric-value">{m?.totalLogs ?? 0} logs</span>
                      </div>
                    </div>
                    <div className="team-card-detail">
                      <span className="team-card-window">{team.currentWindow || 'No window'}</span>
                      <span className="team-card-time">
                        {timeSince(team.lastSeen)}
                        {team.offlineSync && (
                          <span className="sync-badge" title={`Synced offline data: ${formatDuration(team.offlineSync.duration)} offline (${team.offlineSync.logCount} logs, ${team.offlineSync.apps.length} apps)\nSynced: ${new Date(team.offlineSync.syncedAt).toLocaleTimeString()}`}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                            synced
                          </span>
                        )}
                      </span>
                    </div>
                    <button
                      className="admin-btn small accent team-card-btn"
                      onClick={() => { setSelectedTeam(team); setShowReport(true); }}
                    >
                      View Report
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showReport && selectedTeam && (
        <ReportModal
          team={selectedTeam as unknown as Team & { teamId: string }}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>
  );
}

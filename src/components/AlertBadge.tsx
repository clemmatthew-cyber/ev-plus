import { useState, useEffect, useRef, useCallback } from "react";
import type { BettingAlert, AlertSeverity } from "../lib/types";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const SEVERITY_DOT: Record<AlertSeverity, string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-zinc-500",
};

const SEVERITY_BG: Record<AlertSeverity, string> = {
  high: "border-red-500/30 bg-red-500/5",
  medium: "border-amber-500/20 bg-amber-500/5",
  low: "border-white/[0.06] bg-white/[0.02]",
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function AlertBadge() {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<BettingAlert[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/alerts/count`);
      if (res.ok) {
        const data = await res.json();
        setUnread(data.unreadCount ?? 0);
      }
    } catch { /* ignore */ }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/alerts?limit=20`);
      if (res.ok) {
        const data = await res.json();
        setAlerts(data.alerts ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  // Poll unread count every 30s
  useEffect(() => {
    fetchCount();
    const id = setInterval(fetchCount, 30_000);
    return () => clearInterval(id);
  }, [fetchCount]);

  // Fetch full alerts when dropdown opens
  useEffect(() => {
    if (open) fetchAlerts();
  }, [open, fetchAlerts]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const markRead = async (id: number) => {
    try {
      await fetch(`${API_BASE}/api/alerts/${id}/read`, { method: "POST" });
      setAlerts(prev => prev.map(a => a.id === id ? { ...a, isRead: true } : a));
      setUnread(prev => Math.max(0, prev - 1));
    } catch { /* ignore */ }
  };

  const dismiss = async (id: number) => {
    try {
      await fetch(`${API_BASE}/api/alerts/${id}/dismiss`, { method: "POST" });
      setAlerts(prev => prev.filter(a => a.id !== id));
      setUnread(prev => Math.max(0, prev - 1));
    } catch { /* ignore */ }
  };

  return (
    <div className="relative" ref={ref}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1.5 rounded-md text-[#737373] hover:text-[#ededed] hover:bg-white/[0.05] transition-colors"
        title="Alerts"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold text-white bg-red-500 rounded-full">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[340px] max-h-[420px] overflow-y-auto rounded-lg border border-white/[0.08] bg-[#141414] shadow-2xl">
          <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-2.5 border-b border-white/[0.06] bg-[#141414]">
            <span className="text-xs font-semibold text-[#ededed]">Alerts</span>
            {alerts.length > 0 && (
              <span className="text-[10px] text-[#737373]">{alerts.length} active</span>
            )}
          </div>

          {alerts.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-[#737373]">No active alerts</div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {alerts.map(a => (
                <div
                  key={a.id}
                  className={`group px-3 py-2.5 border-l-2 transition-colors ${
                    a.isRead ? "border-transparent opacity-60" : SEVERITY_BG[a.severity]
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${SEVERITY_DOT[a.severity]}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] leading-snug text-[#ededed] break-words">{a.headline}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[9px] text-[#737373]">{timeAgo(a.createdAt)}</span>
                        <span className="text-[9px] text-[#737373] uppercase tracking-wider">{a.alertType.replace(/_/g, " ")}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      {!a.isRead && (
                        <button
                          onClick={() => markRead(a.id)}
                          className="p-1 rounded text-[#737373] hover:text-emerald-400 hover:bg-white/[0.05]"
                          title="Mark read"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => dismiss(a.id)}
                        className="p-1 rounded text-[#737373] hover:text-red-400 hover:bg-white/[0.05]"
                        title="Dismiss"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

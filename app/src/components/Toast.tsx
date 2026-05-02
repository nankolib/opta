import { FC, useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { inferClusterFromUrl, getSolscanTxUrl } from "../utils/env";

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  title: string;
  message?: string;
  txSignature?: string;
}

/** Global toast state — simple pub/sub. */
let listeners: ((toast: ToastMessage) => void)[] = [];

export function showToast(toast: Omit<ToastMessage, "id">) {
  const id = Math.random().toString(36).slice(2);
  listeners.forEach((fn) => fn({ ...toast, id }));
}

/** Toast container — renders at the top-right of the screen. */
export const ToastContainer: FC = () => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const { connection } = useConnection();
  const cluster = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint),
    [connection.rpcEndpoint],
  );

  useEffect(() => {
    const handler = (toast: ToastMessage) => {
      setToasts((prev) => [...prev, toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 6000);
    };
    listeners.push(handler);
    return () => {
      listeners = listeners.filter((fn) => fn !== handler);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-4 z-[100] flex flex-col gap-3 max-w-sm">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`
            rounded-xl border p-4 shadow-2xl backdrop-blur-xl
            ${toast.type === "success" ? "bg-sol-green/10 border-sol-green/30" : ""}
            ${toast.type === "error" ? "bg-loss/10 border-loss/30" : ""}
            ${toast.type === "info" ? "bg-sol-purple/10 border-sol-purple/30" : ""}
          `}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={`text-sm font-semibold ${
                toast.type === "success" ? "text-sol-green" :
                toast.type === "error" ? "text-loss" : "text-sol-purple"
              }`}>
                {toast.title}
              </div>
              {toast.message && (
                <div className="text-xs text-text-secondary mt-1">{toast.message}</div>
              )}
              {toast.txSignature && (
                <a
                  href={getSolscanTxUrl(toast.txSignature, cluster)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gold hover:underline mt-1 inline-block"
                >
                  View on Solscan
                </a>
              )}
            </div>
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="text-text-muted hover:text-text-primary text-xs"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

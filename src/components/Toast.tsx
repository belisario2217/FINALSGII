import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";

type Toast = { id: number; message: string; type: "success" | "error" };
type ToastContextValue = {
  success: (message: string) => void;
  error: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = (message: string, type: Toast["type"]) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, type }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  };
  const value = useMemo(() => ({
    success: (message: string) => show(message, "success"),
    error: (message: string) => show(message, "error")
  }), []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.type}`} key={toast.id}>
            {toast.type === "success" ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
            <span>{toast.message}</span>
            <button className="icon-button subtle" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} aria-label="Cerrar">
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("ToastProvider no está disponible.");
  return value;
}

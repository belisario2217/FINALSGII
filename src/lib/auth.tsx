import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "./api";

export type User = {
  id: number;
  fullName: string;
  email: string;
  roleId: number;
  roleName: string;
  studentId: number | null;
  permissions: string[];
};

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (permission: string) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api<{ user: User }>("/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    login: async (email, password) => {
      const result = await api<{ token: string; user: User }>("/auth/login", {
        method: "POST",
        body: { email, password }
      });
      setToken(result.token);
      setUser(result.user);
    },
    logout: () => {
      setToken(null);
      setUser(null);
    },
    can: (permission) => Boolean(user?.permissions.includes(permission))
  }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider no está disponible.");
  return value;
}

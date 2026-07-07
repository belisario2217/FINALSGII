import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";

const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const StudentsPage = lazy(() => import("./pages/StudentsPage").then((module) => ({ default: module.StudentsPage })));
const GradesPage = lazy(() => import("./pages/GradesPage").then((module) => ({ default: module.GradesPage })));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage").then((module) => ({ default: module.AnalyticsPage })));
const ReportsPage = lazy(() => import("./pages/ReportsPage").then((module) => ({ default: module.ReportsPage })));
const CatalogsPage = lazy(() => import("./pages/CatalogsPage").then((module) => ({ default: module.CatalogsPage })));
const UsersPage = lazy(() => import("./pages/UsersPage").then((module) => ({ default: module.UsersPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const PlansPage = lazy(() => import("./pages/PlansPage").then((module) => ({ default: module.PlansPage })));
const StudentPortalPage = lazy(() => import("./pages/StudentPortalPage").then((module) => ({ default: module.StudentPortalPage })));
const PaymentsPage = lazy(() => import("./pages/PaymentsPage").then((module) => ({ default: module.PaymentsPage })));

function HomePage() {
  const { user, can } = useAuth();
  if (user?.studentId && can("portal.view")) return <Navigate to="/mi-avance" replace />;
  return <DashboardPage />;
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loader"><LoaderCircle className="spin" size={28} /><span>Preparando tu espacio</span></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export function App() {
  const { user } = useAuth();
  return (
    <Suspense fallback={<div className="app-loader"><LoaderCircle className="spin" size={28} /><span>Cargando módulo</span></div>}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="*" element={
          <Protected>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/alumnos" element={<StudentsPage />} />
              <Route path="/calificaciones" element={<GradesPage />} />
              <Route path="/analiticas" element={<AnalyticsPage />} />
              <Route path="/reportes" element={<ReportsPage />} />
              <Route path="/cobros" element={<PaymentsPage />} />
              <Route path="/catalogos" element={<CatalogsPage />} />
              <Route path="/planes" element={<PlansPage />} />
              <Route path="/mi-avance" element={<StudentPortalPage />} />
              <Route path="/usuarios" element={<UsersPage />} />
              <Route path="/configuracion" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Protected>
        } />
      </Routes>
    </Suspense>
  );
}

import { useEffect, useRef, useState } from "react";
import { Building2, Check, DatabaseBackup, Download, History, ImagePlus, Palette, Save, ShieldCheck } from "lucide-react";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { Button, Field, Select } from "../components/Ui";

export function SettingsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const logoRef = useRef<HTMLInputElement>(null);
  const databaseRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<any>(null);
  const [cycles, setCycles] = useState<any[]>([]);
  const [scales, setScales] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [tab, setTab] = useState<"institution" | "audit">("institution");
  const [busy, setBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);

  async function load() {
    const result = await api<any>("/settings");
    setSettings(result.settings);
    setCycles(result.cycles);
    setScales(result.scales);
    if (can("audit.view")) api<any[]>("/settings/audit").then(setAudit);
  }
  useEffect(() => { load(); }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const updated = await api<any>("/settings", {
        method: "PATCH",
        body: {
          institutionName: settings.institution_name,
          address: settings.address,
          phone: settings.phone,
          email: settings.email,
          directorName: settings.director_name,
          activeCycleId: settings.active_cycle_id,
          defaultScaleId: settings.default_scale_id,
          footerText: settings.footer_text,
          primaryColor: settings.primary_color,
          secondaryColor: settings.secondary_color
        }
      });
      setSettings(updated);
      toast.success("Configuración guardada.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible guardar.");
    } finally { setBusy(false); }
  }

  async function uploadLogo(file: File) {
    const body = new FormData();
    body.append("logo", file);
    try {
      const result = await api<{ logoPath: string }>("/settings/logo", { method: "POST", body });
      setSettings({ ...settings, logo_path: result.logoPath });
      toast.success("Logo actualizado.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible subir el logo.");
    }
  }

  async function restoreDatabase(file: File) {
    if (!window.confirm("Esta accion reemplazara los datos actuales al reiniciar el servicio. ¿Deseas continuar?")) {
      if (databaseRef.current) databaseRef.current.value = "";
      return;
    }
    const body = new FormData();
    body.append("database", file);
    setRestoreBusy(true);
    try {
      const result = await api<{ message: string; summary: { students: number; grades: number } }>("/settings/restore-database", { method: "POST", body });
      toast.success(`${result.message} ${result.summary.students} alumnos y ${result.summary.grades} calificaciones.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible restaurar la base.");
    } finally {
      setRestoreBusy(false);
      if (databaseRef.current) databaseRef.current.value = "";
    }
  }

  if (!settings) return <div className="loading-panel">Cargando configuración...</div>;
  async function downloadDatabaseBackup() {
    setBackupBusy(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      await download("/settings/database-backup", `universidad-ifop-respaldo-${date}.db`);
      toast.success("Respaldo descargado.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible descargar el respaldo.");
    } finally {
      setBackupBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <div className="page-tabs">
        <button className={tab === "institution" ? "active" : ""} onClick={() => setTab("institution")}><Building2 size={18} /> Institución</button>
        {can("audit.view") && <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}><History size={18} /> Actividad</button>}
      </div>
      {tab === "institution" ? (
        <form onSubmit={save} className="settings-layout">
          <section className="settings-main">
            <div className="settings-section">
              <div className="settings-title"><Building2 size={20} /><div><h2>Datos institucionales</h2><p>Información usada en boletas y reportes oficiales.</p></div></div>
              <div className="form-grid two">
                <Field label="Nombre de la institución" required><input value={settings.institution_name ?? ""} onChange={(event) => setSettings({ ...settings, institution_name: event.target.value })} required /></Field>
                <Field label="Director o responsable"><input value={settings.director_name ?? ""} onChange={(event) => setSettings({ ...settings, director_name: event.target.value })} /></Field>
                <Field label="Correo"><input type="email" value={settings.email ?? ""} onChange={(event) => setSettings({ ...settings, email: event.target.value })} /></Field>
                <Field label="Teléfono"><input value={settings.phone ?? ""} onChange={(event) => setSettings({ ...settings, phone: event.target.value })} /></Field>
                <Field label="Dirección"><input value={settings.address ?? ""} onChange={(event) => setSettings({ ...settings, address: event.target.value })} /></Field>
                <Field label="Pie de página"><input value={settings.footer_text ?? ""} onChange={(event) => setSettings({ ...settings, footer_text: event.target.value })} /></Field>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-title"><ShieldCheck size={20} /><div><h2>Parámetros académicos</h2><p>Valores predeterminados para la operación activa.</p></div></div>
              <div className="form-grid two">
                <Field label="Ciclo activo"><Select options={cycles} value={settings.active_cycle_id ?? ""} onChange={(event) => setSettings({ ...settings, active_cycle_id: event.target.value })} /></Field>
                <Field label="Escala predeterminada"><Select options={scales} value={settings.default_scale_id ?? ""} onChange={(event) => setSettings({ ...settings, default_scale_id: event.target.value })} /></Field>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-title"><Palette size={20} /><div><h2>Identidad visual</h2><p>Colores aplicados a documentos académicos.</p></div></div>
              <div className="color-fields">
                <Field label="Color principal"><div className="color-input"><input type="color" value={settings.primary_color} onChange={(event) => setSettings({ ...settings, primary_color: event.target.value })} /><span>{settings.primary_color}</span></div></Field>
                <Field label="Color secundario"><div className="color-input"><input type="color" value={settings.secondary_color} onChange={(event) => setSettings({ ...settings, secondary_color: event.target.value })} /><span>{settings.secondary_color}</span></div></Field>
              </div>
            </div>
            <div className="settings-save"><Button type="submit" busy={busy} icon={<Save size={17} />}>Guardar configuración</Button></div>
          </section>
          <aside className="logo-panel">
            <span>Logo institucional</span>
            <div className="logo-preview"><img src={settings.logo_path || "/assets/campus-frontera.jpg"} alt="Logo institucional" /></div>
            <Button type="button" variant="secondary" icon={<ImagePlus size={17} />} onClick={() => logoRef.current?.click()}>Cambiar logo</Button>
            <input ref={logoRef} hidden type="file" accept=".png,.jpg,.jpeg,.webp" onChange={(event) => event.target.files?.[0] && uploadLogo(event.target.files[0])} />
            <small>PNG, JPG o WebP. Máximo 2 MB.</small>
            <div className="document-preview">
              <div style={{ backgroundColor: settings.primary_color }} /><img src={settings.logo_path || "/assets/campus-frontera.jpg"} alt="" /><strong>{settings.institution_name}</strong><i style={{ backgroundColor: settings.secondary_color }} /><p>Vista previa del encabezado</p>
            </div>
            {can("settings.manage") && (
              <div className="database-restore">
                <span>Respaldar informacion</span>
                <Button type="button" variant="secondary" busy={backupBusy} icon={<Download size={17} />} onClick={downloadDatabaseBackup}>Descargar respaldo</Button>
                <small>Copia local de la base SQLite actual.</small>
                <span>Restaurar información</span>
                <Button type="button" variant="secondary" busy={restoreBusy} icon={<DatabaseBackup size={17} />} onClick={() => databaseRef.current?.click()}>Seleccionar respaldo</Button>
                <input ref={databaseRef} hidden type="file" accept=".db,.sqlite,application/x-sqlite3" onChange={(event) => event.target.files?.[0] && restoreDatabase(event.target.files[0])} />
                <small>Archivo SQLite de Universidad IFOP. Máximo 25 MB.</small>
              </div>
            )}
          </aside>
        </form>
      ) : (
        <section className="table-section">
          <header className="section-heading"><div><span>Auditoría</span><h2>Actividad reciente</h2></div></header>
          <div className="audit-list">
            {audit.map((item) => <div key={item.id}><div className="audit-icon"><Check size={16} /></div><div><strong>{item.user_name || "Sistema"}</strong><span>{item.action} · {item.entity_type}{item.entity_id ? ` #${item.entity_id}` : ""}</span></div><time>{new Date(item.created_at).toLocaleString("es-MX")}</time></div>)}
          </div>
        </section>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { CircleOff, Database, MoreHorizontal, Pencil, Plus, Search, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { Modal } from "../components/Modal";
import { Button, EmptyState, Field, Select, StatusBadge } from "../components/Ui";

type CatalogSummary = { key: string; label: string; singular: string };
type FieldDefinition = { name: string; label: string; type?: string; required?: boolean; reference?: string };
type CatalogData = { definition: { label: string; singular: string; fields: FieldDefinition[] }; records: any[] };

export function CatalogsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>([]);
  const [selected, setSelected] = useState("programs");
  const [data, setData] = useState<CatalogData | null>(null);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [references, setReferences] = useState<Record<string, Array<{ id: number; name: string }>>>({});
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [forceDelete, setForceDelete] = useState(false);

  async function load(type = selected) {
    setData(await api<CatalogData>(`/catalogs/${type}`));
  }
  useEffect(() => {
    api<CatalogSummary[]>("/catalogs").then(setCatalogs);
    load();
  }, []);

  async function choose(type: string) {
    setSelected(type);
    setSearch("");
    const result = await api<CatalogData>(`/catalogs/${type}`);
    setData(result);
  }

  async function openForm(record?: any) {
    setEditing(record ?? null);
    setForm(record ? { ...record } : {});
    setModalOpen(true);
    const refs = [...new Set(data?.definition.fields.map((field) => field.reference).filter(Boolean) ?? [])] as string[];
    const entries = await Promise.all(refs.map(async (type) => {
      const result = await api<CatalogData>(`/catalogs/${type}`);
      return [type, result.records.filter((item) => item.is_active).map((item) => ({ id: item.id, name: item.name }))] as const;
    }));
    setReferences(Object.fromEntries(entries));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(editing ? `/catalogs/${selected}/${editing.id}` : `/catalogs/${selected}`, {
        method: editing ? "PATCH" : "POST",
        body: form
      });
      toast.success(editing ? "Registro actualizado." : "Registro creado.");
      setModalOpen(false);
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible guardar.");
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(record: any) {
    try {
      await api(`/catalogs/${selected}/${record.id}`, { method: "DELETE" });
      toast.success("Registro desactivado.");
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible desactivar.");
    }
    setMenuFor(null);
  }

  async function permanentlyDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/catalogs/${selected}/${deleting.id}/permanent${forceDelete ? "?force=true" : ""}`, { method: "DELETE" });
      toast.success(forceDelete ? "Registro y dependencias eliminados." : "Registro eliminado definitivamente.");
      setDeleting(null);
      setForceDelete(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible eliminar el registro.");
    } finally {
      setBusy(false);
    }
  }

  const rows = (data?.records ?? []).filter((record) =>
    !search || Object.values(record).some((item) => String(item ?? "").toLowerCase().includes(search.toLowerCase()))
  );
  const displayFields = data?.definition.fields.slice(0, 5) ?? [];

  return (
    <div className="catalog-layout">
      <aside className="catalog-nav">
        <div><SlidersHorizontal size={18} /><strong>Catálogos</strong></div>
        {catalogs.map((catalog) => <button key={catalog.key} className={selected === catalog.key ? "active" : ""} onClick={() => choose(catalog.key)}>{catalog.label}</button>)}
      </aside>
      <section className="catalog-content">
        <header className="catalog-header">
          <div><span>Administración</span><h2>{data?.definition.label ?? "Catálogo"}</h2><p>{rows.length} registros visibles</p></div>
          {can("catalogs.manage") && <Button icon={<Plus size={18} />} onClick={() => openForm()}>Nuevo registro</Button>}
        </header>
        <div className="sub-toolbar">
          <div className="search-box"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar en este catálogo" /></div>
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr>{displayFields.map((field) => <th key={field.name}>{field.label}</th>)}<th>Estado</th><th aria-label="Acciones" /></tr></thead>
              <tbody>
                {rows.map((record) => (
                  <tr key={record.id} className={!record.is_active ? "row-muted" : ""}>
                    {displayFields.map((field) => (
                      <td key={field.name}>
                        {field.type === "boolean"
                          ? <StatusBadge active={Boolean(record[field.name])} label={record[field.name] ? "Sí" : "No"} />
                          : <span className={field.name === "name" || field.name === "full_name" ? "table-main" : ""}>
                              {field.reference ? record[`${field.name.replace("_id", "")}_name`] ?? record[field.name] : record[field.name] ?? "—"}
                            </span>}
                      </td>
                    ))}
                    <td><StatusBadge active={Boolean(record.is_active)} /></td>
                    <td className="action-cell">
                      {can("catalogs.manage") && <button className="icon-button" onClick={() => setMenuFor(menuFor === record.id ? null : record.id)} aria-label="Acciones"><MoreHorizontal size={18} /></button>}
                      {menuFor === record.id && <div className="row-menu"><button onClick={() => openForm(record)}><Pencil size={16} /> Editar</button>{record.is_active ? <button onClick={() => deactivate(record)}><CircleOff size={16} /> Desactivar</button> : <button onClick={async () => { await api(`/catalogs/${selected}/${record.id}`, { method: "PATCH", body: { is_active: true } }); load(); setMenuFor(null); }}><Database size={16} /> Reactivar</button>}<button className="danger-menu-item" onClick={() => { setDeleting(record); setForceDelete(false); setMenuFor(null); }}><Trash2 size={16} /> Eliminar definitivamente</button></div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState icon={<Database size={24} />} title="Este catálogo está vacío" text="Crea el primer registro para comenzar." />}
      </section>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={`${editing ? "Editar" : "Nuevo"} ${data?.definition.singular.toLowerCase()}`}>
        <form onSubmit={save}>
          <div className="form-grid two">
            {(data?.definition.fields ?? []).map((field) => (
              <Field key={field.name} label={field.label} required={field.required}>
                {field.reference
                  ? <Select options={references[field.reference] ?? []} value={form[field.name] ?? ""} onChange={(event) => setForm({ ...form, [field.name]: event.target.value })} required={field.required} />
                  : field.type === "boolean"
                    ? <label className="toggle-control"><input type="checkbox" checked={Boolean(form[field.name])} onChange={(event) => setForm({ ...form, [field.name]: event.target.checked })} /><i /><span>{form[field.name] ? "Sí" : "No"}</span></label>
                    : <input type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "time" ? "time" : field.type === "color" ? "color" : "text"} value={form[field.name] ?? ""} onChange={(event) => setForm({ ...form, [field.name]: event.target.value })} required={field.required} />}
              </Field>
            ))}
          </div>
          <div className="modal-actions"><Button type="button" variant="ghost" onClick={() => setModalOpen(false)}>Cancelar</Button><Button type="submit" busy={busy}>Guardar</Button></div>
        </form>
      </Modal>

      <Modal open={Boolean(deleting)} onClose={() => { setDeleting(null); setForceDelete(false); }} title="Eliminar definitivamente" size="small">
        <div className="danger-confirmation"><TriangleAlert size={30} /><div><strong>{forceDelete ? "Borrado forzado de datos" : "Esta acción no se puede deshacer"}</strong><p>{forceDelete ? "Se eliminará el registro junto con grupos, inscripciones, calificaciones u otras dependencias relacionadas." : `Se eliminará “${deleting?.name || deleting?.full_name || deleting?.code}”. Si está siendo utilizado, el sistema bloqueará la eliminación.`}</p></div></div>
        <label className="force-delete-control"><input type="checkbox" checked={forceDelete} onChange={(event) => setForceDelete(event.target.checked)} /><span><strong>Forzar borrado</strong><small>Eliminar también todos los datos dependientes</small></span></label>
        <div className="modal-actions"><Button variant="ghost" onClick={() => { setDeleting(null); setForceDelete(false); }}>Cancelar</Button><Button variant="danger" icon={<Trash2 size={17} />} busy={busy} onClick={permanentlyDelete}>{forceDelete ? "Forzar borrado" : "Eliminar"}</Button></div>
      </Modal>
    </div>
  );
}

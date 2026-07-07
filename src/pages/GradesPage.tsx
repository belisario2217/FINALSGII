import { useEffect, useRef, useState } from "react";
import {
  BookOpenCheck, Check, Download, FileDown, FileSpreadsheet, FileText, History,
  Lock, LockOpen, Plus, Save, Search, Upload
} from "lucide-react";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { Modal } from "../components/Modal";
import { Button, EmptyState, Field, Select, StatusBadge } from "../components/Ui";

type Option = { id: number; name: string; default_weight?: number; program_id?: number };
type Assignment = {
  id: number;
  subject_name: string;
  subject_code: string;
  group_id: number;
  group_name: string;
  program_name: string;
  shift_name: string;
  teacher_name: string;
  period_name: string;
  cycle_name: string;
  min_score: number;
  max_score: number;
  passing_score: number;
  grade_entry_locked: number;
  evaluation_mode: "partials" | "criteria" | "final";
};
type RosterRow = {
  enrollment_id: number;
  student_id: number;
  student_number: string;
  student_name: string;
  grade_id: number | null;
  final_score: number | null;
  status: string | null;
  comments: string | null;
  components: Record<string, number>;
  partial_1: number | null;
  partial_2: number | null;
  partial_3: number | null;
};
type Roster = { assignment: Assignment; criteria: any[]; students: RosterRow[] };

export function GradesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selected, setSelected] = useState<Assignment | null>(null);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [drafts, setDrafts] = useState<Record<number, { score: string; comments: string; components: Record<string, string>; partials: [string, string, string] }>>({});
  const [options, setOptions] = useState<Record<string, Option[]>>({});
  const [filters, setFilters] = useState({ groupId: "", teacherId: "", periodId: "" });
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentForm, setAssignmentForm] = useState({ subjectId: "", groupId: "", teacherId: "", periodId: "", gradingScaleId: "", evaluationMode: "partials" });
  const [weights, setWeights] = useState<Record<number, number>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [existingMode, setExistingMode] = useState("ignore");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<any[]>([]);

  async function loadAssignments(current = filters) {
    const query = new URLSearchParams(Object.entries(current).filter(([, value]) => value)).toString();
    const records = await api<Assignment[]>(`/grades/assignments${query ? `?${query}` : ""}`);
    setAssignments(records);
    if (selected) {
      const refreshed = records.find((item) => item.id === selected.id);
      if (refreshed) setSelected(refreshed);
    }
  }

  async function loadRoster(assignment: Assignment) {
    setSelected(assignment);
    const data = await api<Roster>(`/grades/assignment/${assignment.id}/roster`);
    setRoster(data);
    setDrafts(Object.fromEntries(data.students.map((student) => [student.enrollment_id, {
      score: student.final_score == null ? "" : String(student.final_score),
      comments: student.comments ?? "",
      components: Object.fromEntries(Object.entries(student.components ?? {}).map(([key, value]) => [key, String(value)])),
      partials: [student.partial_1, student.partial_2, student.partial_3].map((value) => value == null ? "" : String(value)) as [string, string, string]
    }])));
  }

  useEffect(() => {
    Promise.all(["groups", "teachers", "periods", "subjects", "scales", "criteria"].map(async (type) => {
      const result = await api<{ records: any[] }>(`/catalogs/${type}`);
      return [type, result.records.filter((item) => item.is_active).map((item) => ({
        id: item.id,
        name: item.name || item.full_name,
        default_weight: item.default_weight,
        program_id: item.program_id
      }))] as const;
    })).then((entries) => {
      const mapped = Object.fromEntries(entries);
      setOptions(mapped);
      setWeights(Object.fromEntries((mapped.criteria ?? []).map((criterion: Option) => [criterion.id, criterion.default_weight || 0])));
    });
    loadAssignments();
  }, []);

  async function saveGrades() {
    if (!selected || !roster) return;
    setBusy(true);
    try {
      await api(`/grades/assignment/${selected.id}`, {
        method: "PUT",
        body: {
          grades: roster.students.map((student) => {
            const draft = drafts[student.enrollment_id] ?? { score: "", comments: "", components: {}, partials: ["", "", ""] };
            const componentDraft = draft.components ?? {};
            const hasComponents = Object.values(componentDraft).some((value) => value !== "");
            return {
              enrollmentId: student.enrollment_id,
              score: roster.criteria.length && hasComponents ? null : draft.score,
              comments: draft.comments,
              components: hasComponents ? componentDraft : undefined,
              partials: selected.evaluation_mode === "partials" ? {
                partial1: draft.partials[0], partial2: draft.partials[1], partial3: draft.partials[2]
              } : undefined,
              reason: "Captura desde tablero"
            };
          })
        }
      });
      toast.success("Calificaciones guardadas.");
      await loadRoster(selected);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible guardar.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleLock() {
    if (!selected) return;
    try {
      const updated = await api<Assignment>(`/grades/assignment/${selected.id}/toggle-lock`, { method: "POST" });
      setSelected(updated);
      setRoster((current) => current ? { ...current, assignment: updated } : current);
      toast.success(updated.grade_entry_locked ? "Captura cerrada." : "Captura reabierta.");
      loadAssignments();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible cambiar el cierre.");
    }
  }

  async function createAssignment(event: React.FormEvent) {
    event.preventDefault();
    const criteria = assignmentForm.evaluationMode === "criteria"
      ? Object.entries(weights).filter(([, weight]) => Number(weight) > 0).map(([criterionId, weight]) => ({ criterionId: Number(criterionId), weight: Number(weight) }))
      : [];
    setBusy(true);
    try {
      await api("/grades/assignments", { method: "POST", body: { ...assignmentForm, criteria } });
      toast.success("Asignación académica creada.");
      setAssignmentOpen(false);
      loadAssignments();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible crear la asignación.");
    } finally {
      setBusy(false);
    }
  }

  async function previewImport(file: File) {
    const body = new FormData();
    body.append("file", file);
    setBusy(true);
    try {
      setPreview(await api("/grades/import/preview", { method: "POST", body }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible leer el archivo.");
    } finally {
      setBusy(false);
    }
  }

  async function applyImport() {
    setBusy(true);
    try {
      const result = await api<{ created: number; updated: number; ignored: number }>("/grades/import/apply", {
        method: "POST",
        body: { previewId: preview.previewId, existingMode }
      });
      toast.success(`${result.created} calificaciones nuevas y ${result.updated} actualizadas.`);
      setImportOpen(false);
      setPreview(null);
      if (selected) loadRoster(selected);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No fue posible importar.");
    } finally {
      setBusy(false);
    }
  }

  async function showHistory(gradeId: number | null) {
    if (!gradeId) return;
    setHistory(await api<any[]>(`/grades/history/${gradeId}`));
    setHistoryOpen(true);
  }

  const filteredStudents = roster?.students.filter((student) =>
    !search || `${student.student_number} ${student.student_name}`.toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  return (
    <div className="grades-layout">
      <aside className="assignment-pane">
        <div className="assignment-toolbar">
          <div><span>Asignaciones</span><strong>{assignments.length} materias</strong></div>
          {can("catalogs.manage") && <button className="icon-button primary-icon" onClick={() => setAssignmentOpen(true)} title="Nueva asignación"><Plus size={18} /></button>}
        </div>
        <div className="assignment-filters">
          <Select options={options.groups ?? []} value={filters.groupId} onChange={(event) => { const next = { ...filters, groupId: event.target.value }; setFilters(next); loadAssignments(next); }} placeholder="Todos los grupos" />
          <Select options={options.periods ?? []} value={filters.periodId} onChange={(event) => { const next = { ...filters, periodId: event.target.value }; setFilters(next); loadAssignments(next); }} placeholder="Todos los periodos" />
        </div>
        <div className="assignment-list">
          {assignments.map((assignment) => (
            <button key={assignment.id} className={selected?.id === assignment.id ? "active" : ""} onClick={() => loadRoster(assignment)}>
              <div className="subject-mark">{assignment.subject_code.slice(0, 3)}</div>
              <div><strong>{assignment.subject_name}</strong><span>{assignment.group_name} · {assignment.period_name}</span><small>{assignment.teacher_name}</small></div>
              {assignment.grade_entry_locked ? <Lock size={15} /> : <LockOpen size={15} />}
            </button>
          ))}
        </div>
      </aside>

      <section className="grade-workspace">
        {selected && roster ? (
          <>
            <header className="grade-header">
              <div>
                <span>{selected.program_name} · {selected.cycle_name}</span>
                <h2>{selected.subject_name}</h2>
                <p>Grupo {selected.group_name} · {selected.shift_name} · {selected.teacher_name}</p>
              </div>
              <div className="grade-header-actions">
                {can("grades.import") && <Button variant="secondary" icon={<Upload size={17} />} onClick={() => { setImportOpen(true); setPreview(null); }}>Importar</Button>}
                {can("grades.export") && (
                  <div className="split-actions">
                    <button title="Exportar Excel" onClick={() => download(`/grades/export/file?format=xlsx&groupId=${selected.group_id}`, "calificaciones.xlsx")}><FileSpreadsheet size={17} /></button>
                    <button title="Exportar CSV" onClick={() => download(`/grades/export/file?format=csv&groupId=${selected.group_id}`, "calificaciones.csv")}><FileDown size={17} /></button>
                    <button title="Exportar PDF" onClick={() => download(`/grades/export/file?format=pdf&groupId=${selected.group_id}`, "calificaciones.pdf")}><FileText size={17} /></button>
                  </div>
                )}
                {can("grades.close") && <Button variant="secondary" icon={selected.grade_entry_locked ? <LockOpen size={17} /> : <Lock size={17} />} onClick={toggleLock}>{selected.grade_entry_locked ? "Reabrir" : "Cerrar"}</Button>}
                {can("grades.manage") && <Button icon={<Save size={17} />} busy={busy} disabled={Boolean(selected.grade_entry_locked)} onClick={saveGrades}>Guardar</Button>}
              </div>
            </header>
            <div className="grade-meta">
              <div><span>Escala</span><strong>{selected.min_score} a {selected.max_score}</strong></div>
              <div><span>Mínimo aprobatorio</span><strong>{selected.passing_score}</strong></div>
              <div><span>Captura</span><StatusBadge active={!selected.grade_entry_locked} label={selected.grade_entry_locked ? "Cerrada" : "Abierta"} /></div>
              <div className="search-box compact"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar alumno" /></div>
            </div>
            <div className="grade-table-wrap">
              <table className="grade-table">
                <thead><tr><th>#</th><th>Alumno</th>{selected.evaluation_mode === "partials"
                  ? <><th>Parcial 1</th><th>Parcial 2</th><th>Parcial 3</th></>
                  : roster.criteria.map((criterion) => <th key={criterion.id}>{criterion.name}<small>{criterion.weight}%</small></th>)}<th>{selected.evaluation_mode === "final" ? "Calificación" : "Promedio"}</th><th>Resultado</th><th>Observaciones</th><th aria-label="Historial" /></tr></thead>
                <tbody>
                  {filteredStudents.map((student, index) => {
                    const draft = drafts[student.enrollment_id] ?? { score: "", comments: "", components: {}, partials: ["", "", ""] as [string, string, string] };
                    const componentDraft = draft.components ?? {};
                    const hasAnyComponents = roster.criteria.some((criterion) => componentDraft[String(criterion.id)] !== "" && componentDraft[String(criterion.id)] !== undefined);
                    const hasAllComponents = roster.criteria.length > 0 && roster.criteria.every((criterion) => componentDraft[String(criterion.id)] !== "" && componentDraft[String(criterion.id)] !== undefined);
                    const computed = roster.criteria.reduce((sum, criterion) => sum + (Number(componentDraft[String(criterion.id)]) || 0) * Number(criterion.weight) / 100, 0);
                    const capturedPartials = draft.partials.filter((value) => value !== "").map(Number);
                    const partialAverage = capturedPartials.length ? capturedPartials.reduce((sum, value) => sum + value, 0) / capturedPartials.length : 0;
                    const score = selected.evaluation_mode === "partials"
                      ? partialAverage
                      : roster.criteria.length
                        ? hasAllComponents ? computed : !hasAnyComponents && draft.score !== "" ? Number(draft.score) : computed
                        : Number(draft.score);
                    const hasScore = selected.evaluation_mode === "partials"
                      ? capturedPartials.length > 0
                      : roster.criteria.length ? hasAllComponents || (!hasAnyComponents && draft.score !== "") : draft.score !== "";
                    const complete = selected.evaluation_mode === "partials" ? capturedPartials.length === 3 : hasScore;
                    const passed = complete && score >= selected.passing_score;
                    return (
                      <tr key={student.enrollment_id}>
                        <td>{String(index + 1).padStart(2, "0")}</td>
                        <td><div className="person-cell"><div className="mini-avatar">{student.student_name.split(" ").slice(0, 2).map((part) => part[0]).join("")}</div><div><strong>{student.student_name}</strong><span>{student.student_number}</span></div></div></td>
                        {selected.evaluation_mode === "partials"
                          ? draft.partials.map((value, partialIndex) => <td key={partialIndex}><input className="component-input" aria-label={`Parcial ${partialIndex + 1} de ${student.student_name}`} type="number" min={selected.min_score} max={selected.max_score} step="0.1" disabled={Boolean(selected.grade_entry_locked)} value={value} onChange={(event) => { const partials = [...draft.partials] as [string, string, string]; partials[partialIndex] = event.target.value; setDrafts({ ...drafts, [student.enrollment_id]: { ...draft, partials } }); }} /></td>)
                          : roster.criteria.map((criterion) => <td key={criterion.id}><input className="component-input" aria-label={`${criterion.name} de ${student.student_name}`} type="number" min={selected.min_score} max={selected.max_score} step="0.1" disabled={Boolean(selected.grade_entry_locked)} value={componentDraft[String(criterion.id)] ?? ""} onChange={(event) => setDrafts({ ...drafts, [student.enrollment_id]: { ...draft, components: { ...componentDraft, [String(criterion.id)]: event.target.value } } })} /></td>)}
                        <td>{selected.evaluation_mode !== "final"
                          ? <output className={`computed-grade ${complete ? passed ? "grade-pass" : "grade-fail" : ""}`}>{hasScore ? score.toFixed(1) : "—"}</output>
                          : <input className={`grade-input ${hasScore ? passed ? "grade-pass" : "grade-fail" : ""}`} type="number" min={selected.min_score} max={selected.max_score} step="0.1" disabled={Boolean(selected.grade_entry_locked)} value={draft.score} onChange={(event) => setDrafts({ ...drafts, [student.enrollment_id]: { ...draft, score: event.target.value } })} />}
                        </td>
                        <td>{!complete ? <StatusBadge label={hasScore ? "En curso" : "Pendiente"} /> : <StatusBadge active={passed} label={passed ? "Aprobada" : "Reprobada"} />}</td>
                        <td><input className="comments-input" disabled={Boolean(selected.grade_entry_locked)} value={draft.comments} onChange={(event) => setDrafts({ ...drafts, [student.enrollment_id]: { ...draft, comments: event.target.value } })} placeholder="Agregar observación" /></td>
                        <td><button className="icon-button" disabled={!student.grade_id} onClick={() => showHistory(student.grade_id)} title="Ver historial"><History size={17} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <EmptyState icon={<BookOpenCheck size={27} />} title="Selecciona una materia" text="Elige una asignación para consultar y capturar calificaciones." />
        )}
      </section>

      <Modal open={assignmentOpen} onClose={() => setAssignmentOpen(false)} title="Nueva asignación académica" size="large">
        <form onSubmit={createAssignment}>
          <div className="form-grid three">
            <Field label="Materia" required><Select options={options.subjects ?? []} value={assignmentForm.subjectId} onChange={(event) => setAssignmentForm({ ...assignmentForm, subjectId: event.target.value })} required /></Field>
            <Field label="Grupo" required><Select options={options.groups ?? []} value={assignmentForm.groupId} onChange={(event) => setAssignmentForm({ ...assignmentForm, groupId: event.target.value })} required /></Field>
            <Field label="Docente" required><Select options={options.teachers ?? []} value={assignmentForm.teacherId} onChange={(event) => setAssignmentForm({ ...assignmentForm, teacherId: event.target.value })} required /></Field>
            <Field label="Periodo" required><Select options={options.periods ?? []} value={assignmentForm.periodId} onChange={(event) => setAssignmentForm({ ...assignmentForm, periodId: event.target.value })} required /></Field>
            <Field label="Escala" required><Select options={options.scales ?? []} value={assignmentForm.gradingScaleId} onChange={(event) => setAssignmentForm({ ...assignmentForm, gradingScaleId: event.target.value })} required /></Field>
            <Field label="Tipo de evaluación" required><select value={assignmentForm.evaluationMode} onChange={(event) => setAssignmentForm({ ...assignmentForm, evaluationMode: event.target.value })}><option value="partials">Tres parciales</option><option value="criteria">Criterios ponderados</option><option value="final">Calificación final</option></select></Field>
          </div>
          {assignmentForm.evaluationMode === "criteria" && <>
            <div className="form-section-title"><Check size={18} /><div><strong>Ponderaciones</strong><span>El total activo debe sumar 100%</span></div><b className="weight-total">{Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0)}%</b></div>
            <div className="criteria-grid">
              {(options.criteria ?? []).map((criterion) => (
                <Field label={criterion.name} key={criterion.id}>
                  <div className="suffix-input"><input type="number" min="0" max="100" value={weights[criterion.id] ?? 0} onChange={(event) => setWeights({ ...weights, [criterion.id]: Number(event.target.value) })} /><span>%</span></div>
                </Field>
              ))}
            </div>
          </>}
          <div className="modal-actions"><Button type="button" variant="ghost" onClick={() => setAssignmentOpen(false)}>Cancelar</Button><Button type="submit" busy={busy}>Crear asignación</Button></div>
        </form>
      </Modal>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Importar calificaciones" size="large">
        {!preview ? (
          <div className="import-step">
            <div className="drop-zone" onClick={() => fileRef.current?.click()}>
              <FileSpreadsheet size={36} /><strong>Selecciona un archivo Excel o CSV</strong><span>La validación no modifica datos</span>
              <input ref={fileRef} hidden type="file" accept=".xlsx,.xls,.csv" onChange={(event) => event.target.files?.[0] && previewImport(event.target.files[0])} />
            </div>
            <button className="template-link" onClick={() => download("/grades/template/import.xlsx", "plantilla-calificaciones.xlsx")}><Download size={17} /> Descargar plantilla base</button>
          </div>
        ) : (
          <div className="preview-step">
            <div className="import-summary">
              <div><span>Filas</span><strong>{preview.summary.total}</strong></div><div className="summary-valid"><span>Válidas</span><strong>{preview.summary.valid}</strong></div>
              <div className="summary-error"><span>Con error</span><strong>{preview.summary.errors}</strong></div><div><span>Existentes</span><strong>{preview.summary.existing}</strong></div>
            </div>
            {preview.errors.length > 0 && <div className="error-list">{preview.errors.slice(0, 6).map((error: any) => <p key={`${error.row}-${error.message}`}><b>Fila {error.row}</b>{error.message}</p>)}</div>}
            <div className="segmented"><button className={existingMode === "ignore" ? "active" : ""} onClick={() => setExistingMode("ignore")}>Ignorar existentes</button><button className={existingMode === "update" ? "active" : ""} onClick={() => setExistingMode("update")}>Actualizar existentes</button></div>
            <div className="mini-preview-table"><table><thead><tr><th>Fila</th><th>Matrícula</th><th>Materia</th><th>Calificación</th></tr></thead><tbody>
              {preview.rows.slice(0, 8).map((row: any) => <tr key={row.row}><td>{row.row}</td><td>{row.studentNumber}</td><td>{row.subject}</td><td><strong>{row.score}</strong></td></tr>)}
            </tbody></table></div>
            <div className="modal-actions"><Button variant="ghost" onClick={() => setPreview(null)}>Elegir otro archivo</Button><Button busy={busy} onClick={applyImport} disabled={!preview.summary.valid}>Confirmar importación</Button></div>
          </div>
        )}
      </Modal>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Historial de calificación">
        <div className="timeline">
          {history.map((item) => (
            <div key={item.id}><i /><div><strong>{item.old_score ?? "Sin captura"} → {item.new_score ?? "Pendiente"}</strong><span>{item.reason || "Modificación"} · {item.changed_by_name}</span><small>{new Date(item.changed_at).toLocaleString("es-MX")}</small></div></div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

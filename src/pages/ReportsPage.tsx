import { useEffect, useState } from "react";
import {
  Award, ClipboardCheck, Download, FileSpreadsheet, FileText, GraduationCap, Printer,
  Sheet, UserRoundX, UsersRound
} from "lucide-react";
import { api, download, openDocument } from "../lib/api";
import { useToast } from "../components/Toast";
import { Button, Field, Select } from "../components/Ui";

type Option = { id: number; name: string };

const reports = [
  { type: "students", title: "Lista de alumnos", description: "Directorio por grupo con programa, turno y estatus.", icon: UsersRound },
  { type: "attendance", title: "Lista de asistencia", description: "Formato básico imprimible para control diario.", icon: ClipboardCheck },
  { type: "gradebook", title: "Concentrado de calificaciones", description: "Resultados por alumno, materia y periodo.", icon: Sheet },
  { type: "subjects", title: "Reporte por materia", description: "Promedio, evaluaciones e índice de reprobación.", icon: FileText },
  { type: "teachers", title: "Reporte por docente", description: "Materias, grupos asignados y promedio general.", icon: GraduationCap },
  { type: "failed", title: "Alumnos reprobados", description: "Resultados bajo el mínimo aprobatorio.", icon: UserRoundX },
  { type: "outstanding", title: "Alumnos destacados", description: "Promedios generales iguales o superiores a 9.", icon: Award }
];

export function ReportsPage() {
  const toast = useToast();
  const [options, setOptions] = useState<Record<string, Option[]>>({});
  const [groupId, setGroupId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [periodId, setPeriodId] = useState("");

  useEffect(() => {
    Promise.all(["groups", "periods"].map(async (type) => {
      const result = await api<{ records: any[] }>(`/catalogs/${type}`);
      return [type, result.records.filter((item) => item.is_active).map((item) => ({ id: item.id, name: item.name }))] as const;
    })).then((entries) => setOptions(Object.fromEntries(entries)));
    api<{ records: any[] }>("/students?pageSize=100").then((result) =>
      setOptions((current) => ({ ...current, students: result.records.map((student) => ({ id: student.id, name: `${student.student_number} · ${student.full_name}` })) }))
    );
  }, []);

  function reportPath(type: string, format: string) {
    const query = new URLSearchParams({ format });
    if (groupId) query.set("groupId", groupId);
    return `/reports/data/${type}?${query}`;
  }

  function reportCard(mode: "student" | "group") {
    const query = new URLSearchParams();
    if (mode === "student" && studentId) query.set("studentId", studentId);
    if (mode === "group" && groupId) query.set("groupId", groupId);
    if (periodId) query.set("periodId", periodId);
    if (!query.has(mode === "student" ? "studentId" : "groupId")) {
      toast.error(`Selecciona un ${mode === "student" ? "alumno" : "grupo"}.`);
      return;
    }
    openDocument(`/reports/report-card.pdf?${query}`);
  }

  return (
    <div className="page-stack">
      <section className="report-card-builder">
        <div className="report-builder-intro">
          <div className="report-builder-icon"><GraduationCap size={28} /></div>
          <div><span>Documento oficial</span><h2>Boletas de calificaciones</h2><p>Generación individual o masiva con identidad institucional.</p></div>
        </div>
        <div className="report-builder-controls">
          <Field label="Alumno"><Select options={options.students ?? []} value={studentId} onChange={(event) => setStudentId(event.target.value)} placeholder="Seleccionar alumno" /></Field>
          <Field label="Grupo"><Select options={options.groups ?? []} value={groupId} onChange={(event) => setGroupId(event.target.value)} placeholder="Seleccionar grupo" /></Field>
          <Field label="Periodo"><Select options={options.periods ?? []} value={periodId} onChange={(event) => setPeriodId(event.target.value)} placeholder="Todos los periodos" /></Field>
          <div className="builder-buttons"><Button variant="secondary" icon={<Printer size={17} />} onClick={() => reportCard("student")}>Boleta individual</Button><Button icon={<Sheet size={17} />} onClick={() => reportCard("group")}>Boletas por grupo</Button></div>
        </div>
      </section>

      <section>
        <div className="section-heading standalone"><div><span>Formatos operativos</span><h2>Reportes disponibles</h2></div><Field label="Filtrar por grupo"><Select options={options.groups ?? []} value={groupId} onChange={(event) => setGroupId(event.target.value)} placeholder="Todos los grupos" /></Field></div>
        <div className="report-grid">
          {reports.map((report) => (
            <article className="report-item" key={report.type}>
              <div className="report-item-icon"><report.icon size={23} /></div>
              <div><h3>{report.title}</h3><p>{report.description}</p></div>
              <div className="report-actions">
                <button title="Abrir PDF" onClick={() => openDocument(reportPath(report.type, "pdf"))}><FileText size={17} /><span>PDF</span></button>
                <button title="Descargar Excel" onClick={() => download(reportPath(report.type, "xlsx"), `${report.type}.xlsx`)}><FileSpreadsheet size={17} /><span>Excel</span></button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

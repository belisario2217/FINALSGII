<section className="table-section">
  <header className="section-heading">
    <div>
      <span>Colegiaturas</span>
      <h2>Pagos esperados</h2>
    </div>
  </header>
  <div className="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Periodo</th>
          <th>Fecha estimada</th>
          <th>Esperado</th>
          <th>Pagado</th>
          <th>Pendiente</th>
          <th>Estatus</th>
        </tr>
      </thead>
      <tbody>
        {account.billing.schedule.map((item) => (
          <tr key={item.period}>
            <td>{item.period}</td>
            <td>{item.dueDate ?? <span className="muted-cell">Sin fecha</span>}</td>
            <td>{money(item.expectedAmount)}</td>
            <td>{money(item.paidAmount)}</td>
            <td>{money(item.pendingAmount)}</td>
            <td>
              <StatusBadge
                active={item.status === "paid"}
                label={
                  item.status === "paid"
                    ? "Pagado"
                    : item.status === "partial"
                      ? "Parcial"
                      : item.status === "not_due"
                        ? "Por cargar"
                        : "Pendiente"
                }
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
  {!account.billing.schedule.length && (
    <EmptyState
      icon={<WalletCards size={25} />}
      title="Colegiatura sin configurar"
      text="Agrega el monto de colegiatura en el plan academico."
    />
  )}
</section>

import { app } from "./app.js";

const port = Number(process.env.PORT) || 4100;
const host = "0.0.0.0";

app.listen(port, host, () => {
  console.log(`Universidad IFOP disponible en http://${host}:${port}`);
});

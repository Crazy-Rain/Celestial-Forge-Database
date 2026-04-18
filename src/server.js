const { app } = require('./app');

const rawPort = process.env.PORT;
let port = 3000;

if (rawPort !== undefined) {
  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    console.error(`Invalid PORT value "${rawPort}". Expected an integer between 1 and 65535.`);
    process.exit(1);
  }
  port = parsedPort;
}

app.listen(port, () => {
  console.log(`Celestial Forge Engine listening on :${port}`);
});

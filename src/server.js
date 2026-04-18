const { app } = require('./app');

// Validate PORT environment variable
let port = 3000;
if (process.env.PORT) {
  const parsed = parseInt(process.env.PORT, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`Invalid PORT environment variable: "${process.env.PORT}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  port = parsed;
}

app.listen(port, () => {
  console.log(`Celestial Forge Engine listening on :${port}`);
});
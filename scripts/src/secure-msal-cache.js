/**
 * MSAL persistence that never permits a plaintext fallback.
 */

const os = require("os");
const path = require("path");

const CACHE_DIR = path.join(os.homedir(), ".copilot-studio-cli");
const SERVICE_NAME = "copilot-studio-cli";

async function createSecureCachePlugin(
  accountName,
  loadDependencies = () => require("@azure/msal-node-extensions")
) {
  const {
    PersistenceCreator,
    PersistenceCachePlugin,
    DataProtectionScope,
  } = loadDependencies();

  const persistence = await PersistenceCreator.createPersistence({
    cachePath: path.join(CACHE_DIR, `${accountName}.cache.json`),
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: SERVICE_NAME,
    accountName,
    usePlaintextFileOnLinux: false,
  });
  return new PersistenceCachePlugin(persistence);
}

module.exports = { createSecureCachePlugin };

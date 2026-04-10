export function isInsecureTlsEnabled(config = {}) {
  const runtimeFlag = config?.network?.insecureTls;
  if (runtimeFlag === true) {
    return true;
  }

  return process.env.LLAMAPARSE_INSECURE_TLS === "1" || process.env.DRUG_LABEL_INSECURE_TLS === "1";
}

export function applyGlobalTlsRuntimeConfig(config = {}) {
  if (!isInsecureTlsEnabled(config)) {
    return false;
  }

  process.env.DRUG_LABEL_INSECURE_TLS = "1";
  process.env.LLAMAPARSE_INSECURE_TLS = "1";
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return true;
}

export function getCurlTlsArgs() {
  return process.env.DRUG_LABEL_INSECURE_TLS === "1" ? ["-k"] : [];
}

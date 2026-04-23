import axios from 'axios';
import React, { useEffect, useState } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Spinner } from '../components/Spinner.js';
import { useTimeout } from '../hooks/useTimeout.js';
import { Box, Text } from '../ink.js';
import { getSSLErrorHint } from '../services/api/errorUtils.js';
import { getUserAgent } from './http.js';
import { logError } from './log.js';
export interface PreflightCheckResult {
  success: boolean;
  error?: string;
  sslHint?: string;
}
async function checkEndpoints(): Promise<PreflightCheckResult> {
  try {
    // 使用国内可访问的域名进行连通性检查
    const endpoints = ['https://www.baidu.com'];
    const checkEndpoint = async (url: string): Promise<PreflightCheckResult> => {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': getUserAgent()
          }
        });
        if (response.status !== 200) {
          const hostname = new URL(url).hostname;
          return {
            success: false,
            error: `Failed to connect to ${hostname}: Status ${response.status}`
          };
        }
        return {
          success: true
        };
      } catch (error) {
        const hostname = new URL(url).hostname;
        const sslHint = getSSLErrorHint(error);
        return {
          success: false,
          error: `Failed to connect to ${hostname}: ${error instanceof Error ? (error as ErrnoException).code || error.message : String(error)}`,
          sslHint: sslHint ?? undefined
        };
      }
    };
    const results = await Promise.all(endpoints.map(checkEndpoint));
    const failedResult = results.find(result => !result.success);
    if (failedResult) {
      // Log failure to Statsig
      logEvent('zy_preflight_check_failed', {
        isConnectivityError: false,
        hasErrorMessage: !!failedResult.error,
        isSSLError: !!failedResult.sslHint
      });
    }
    return failedResult || {
      success: true
    };
  } catch (error) {
    logError(error as Error);

    // Log to Statsig
    logEvent('zy_preflight_check_failed', {
      isConnectivityError: true
    });
    return {
      success: false,
      error: `Connectivity check error: ${error instanceof Error ? (error as ErrnoException).code || error.message : String(error)}`
    };
  }
}
interface PreflightStepProps {
  onSuccess: () => void;
}
export function PreflightStep({
  onSuccess
}: PreflightStepProps) {
  const [result, setResult] = useState(null);
  const [isChecking, setIsChecking] = useState(true);
  const showSpinner = useTimeout(1000) && isChecking;
  useEffect(() => {
    const run = async function run() {
      const checkResult = await checkEndpoints();
      setResult(checkResult);
      setIsChecking(false);
    };
    run();
  }, []);
  useEffect(() => {
    if (result?.success) {
      onSuccess();
    } else {
      if (result && !result.success) {
        const timer = setTimeout(() => process.exit(1), 100);
        return () => clearTimeout(timer);
      }
    }
  }, [result, onSuccess]);
  const t5 = isChecking && showSpinner ? <Box paddingLeft={1}><Spinner /><Text>Checking connectivity...</Text></Box> : !result?.success && !isChecking && <Box flexDirection="column" gap={1}><Text color="error">Unable to connect to API services</Text><Text color="error">{result?.error}</Text>{result?.sslHint ? <Box flexDirection="column" gap={1}><Text>{result.sslHint}</Text><Text color="suggestion">See https://code.zy.com/docs/en/network-config</Text></Box> : <Box flexDirection="column" gap={1}><Text>Please check your internet connection and network settings.</Text><Text>Note: ZY Code might not be available in your country. Check supported countries at{" "}<Text color="suggestion">https://anthropic.com/supported-countries</Text></Text></Box>}</Box>;
  return <Box flexDirection="column" gap={1} paddingLeft={1}>{t5}</Box>;
}

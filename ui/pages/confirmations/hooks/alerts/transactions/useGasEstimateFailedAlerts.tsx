/* eslint-disable @typescript-eslint/naming-convention */
'use no memo';

import {
  Box,
  BoxFlexDirection,
  Text,
  TextColor,
  TextVariant,
} from '@metamask/design-system-react';
import React, { useMemo } from 'react';
import {
  AlertActionKey,
  RowAlertKey,
} from '../../../../../components/app/confirm/info/row/constants';
import { Alert } from '../../../../../ducks/confirm-alerts/confirm-alerts';
import { Severity } from '../../../../../helpers/constants/design-system';
import { useI18nContext } from '../../../../../hooks/useI18nContext';
import { RevertReason } from '../../../components/revert-reason/revert-reason';
import { useEstimationFailed } from '../../gas/useEstimationFailed';
import { useIsNetworkGasSponsored } from '../../../../../hooks/useIsNetworkGasSponsored';
import { useTransactionMetadataRequest } from '../../transactions/useTransactionMetadataRequest';

export function useGasEstimateFailedAlerts(): Alert[] {
  const t = useI18nContext();
  const estimationFailed = useEstimationFailed();

  const { chainId } = useTransactionMetadataRequest();

  // Cannot rely on per-tx `isGasFeeSponsored` because it is set to `false` when fail.
  const { isNetworkGasSponsored } = useIsNetworkGasSponsored(chainId);

  return useMemo(() => {
    if (!estimationFailed || isNetworkGasSponsored) {
      return [];
    }

    return [
      {
        actions: [
          {
            key: AlertActionKey.ShowAdvancedGasFeeModal,
            label: t('alertActionUpdateGas'),
          },
        ],
        content: <GasEstimateFailedAlertMessage />,
        field: RowAlertKey.EstimatedFee,
        key: 'gasEstimateFailed',
        reason: t('alertReasonGasEstimateFailed'),
        severity: Severity.Warning,
      },
    ];
  }, [t, estimationFailed, isNetworkGasSponsored]);
}

function GasEstimateFailedAlertMessage() {
  const t = useI18nContext();

  return (
    <Box flexDirection={BoxFlexDirection.Column} gap={2}>
      <Text
        variant={TextVariant.BodyMd}
        color={TextColor.TextDefault}
        data-testid="alert-modal__selected-alert"
      >
        {t('alertMessageGasEstimateFailed')}
      </Text>
      <RevertReason
        source="gas"
        data-testid="gas-estimate-failed-revert-reason"
      />
    </Box>
  );
}

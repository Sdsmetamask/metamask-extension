import React, { useCallback, useContext, useState } from 'react';
import { upperFirst } from 'lodash';
import {
  AvatarIcon,
  AvatarIconSize,
  Box,
  ButtonIcon,
  ButtonIconSize,
  IconName,
  Text,
  TextVariant,
  FontWeight,
} from '@metamask/design-system-react';

import { HardwareDeviceNames } from '../../../../shared/constants/hardware-wallets';
import { MetaMetricsEventName } from '../../../../shared/constants/metametrics';
import { MetaMetricsContext } from '../../../contexts/metametrics';
import { useI18nContext } from '../../../hooks/useI18nContext';

const isUSBSupported = !process.env.IN_TEST && window.navigator.usb;

type WalletOption = {
  id: string;
  labelKey: string;
  device: string;
  testId: string;
  iconName: IconName;
};

const WALLET_OPTIONS: WalletOption[] = [
  {
    id: 'ledger',
    labelKey: 'ledger',
    device: HardwareDeviceNames.ledger,
    testId: 'connect-hardware-wallet-ledger',
    iconName: IconName.Question,
  },
  {
    id: 'keystone',
    labelKey: 'keystone',
    device: HardwareDeviceNames.qr,
    testId: 'connect-hardware-wallet-keystone',
    iconName: IconName.Question,
  },
  {
    id: 'trezor',
    labelKey: 'trezor',
    device: HardwareDeviceNames.trezor,
    testId: 'connect-hardware-wallet-trezor',
    iconName: IconName.Question,
  },
  {
    id: 'onekey',
    labelKey: 'oneKey',
    device: HardwareDeviceNames.oneKey,
    testId: 'connect-hardware-wallet-onekey',
    iconName: IconName.Question,
  },
  {
    id: 'lattice',
    labelKey: 'lattice',
    device: HardwareDeviceNames.lattice,
    testId: 'connect-hardware-wallet-lattice',
    iconName: IconName.Question,
  },
  {
    id: 'other-qr',
    labelKey: 'otherQrWallet',
    device: HardwareDeviceNames.qr,
    testId: 'connect-hardware-wallet-other-qr',
    iconName: IconName.QrCode,
  },
];

type SelectHardwareProps = {
  onCancel: () => void;
  connectToHardwareWallet: (device: string) => void;
  browserSupported: boolean;
};

const SelectHardware = ({
  onCancel,
  connectToHardwareWallet,
  browserSupported,
}: SelectHardwareProps) => {
  const t = useI18nContext();
  const { trackEvent } = useContext(MetaMetricsContext);
  const [trezorRequestDevicePending, setTrezorRequestDevicePending] =
    useState(false);

  const handleWalletSelect = useCallback(
    async (option: WalletOption) => {
      if (trezorRequestDevicePending) {
        return;
      }

      trackEvent({
        event: MetaMetricsEventName.HardwareWalletMarketingButtonClicked,
        properties: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          button_type: 'select',
          // eslint-disable-next-line @typescript-eslint/naming-convention
          device_type: upperFirst(option.device),
        },
      });

      if (option.device === HardwareDeviceNames.trezor && isUSBSupported) {
        setTrezorRequestDevicePending(true);
        try {
          await window.navigator.usb.requestDevice({
            filters: [
              { vendorId: 0x534c, productId: 0x0001 },
              { vendorId: 0x1209, productId: 0x53c0 },
              { vendorId: 0x1209, productId: 0x53c1 },
            ],
          });
        } catch (e) {
          if (!(e instanceof Error) || !e.message.match('No device selected')) {
            throw e;
          }
        } finally {
          setTrezorRequestDevicePending(false);
        }
      }

      connectToHardwareWallet(option.device);
    },
    [connectToHardwareWallet, trackEvent, trezorRequestDevicePending],
  );

  if (!browserSupported) {
    return (
      <Box className="hw-connect__unsupported-browser" paddingHorizontal={4}>
        <Box paddingTop={4} paddingBottom={6}>
          <Text variant={TextVariant.HeadingLg} fontWeight={FontWeight.Bold}>
            {t('browserNotSupported')}
          </Text>
        </Box>
        <Text variant={TextVariant.BodyMd}>
          {t('chromeRequiredForHardwareWallets')}
        </Text>
      </Box>
    );
  }

  return (
    <Box className="select-hardware">
      <Box paddingHorizontal={3} paddingVertical={4}>
        <ButtonIcon
          iconName={IconName.ArrowLeft}
          size={ButtonIconSize.Md}
          ariaLabel={t('back') as string}
          onClick={onCancel}
          data-testid="hardware-connect-close-btn"
        />
      </Box>
      <Box paddingHorizontal={4} className="select-hardware__content">
        <Box marginBottom={6}>
          <Text variant={TextVariant.HeadingLg} fontWeight={FontWeight.Bold}>
            {t('connectAHardwareWallet')}
          </Text>
        </Box>
        <Box className="select-hardware__wallet-list" gap={3}>
          {WALLET_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="select-hardware__wallet-option"
              data-testid={option.testId}
              onClick={() => handleWalletSelect(option)}
              disabled={trezorRequestDevicePending}
            >
              <AvatarIcon iconName={option.iconName} size={AvatarIconSize.Lg} />
              <Text variant={TextVariant.BodyMd} fontWeight={FontWeight.Medium}>
                {t(option.labelKey)}
              </Text>
            </button>
          ))}
        </Box>
      </Box>
    </Box>
  );
};

export default SelectHardware;

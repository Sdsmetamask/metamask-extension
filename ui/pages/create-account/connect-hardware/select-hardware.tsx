import React, { useCallback, useContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { upperFirst } from 'lodash';
import {
  Box,
  ButtonIcon,
  ButtonIconSize,
  Icon,
  IconName,
  IconSize,
  IconColor,
  Text,
  TextVariant,
  FontWeight,
} from '@metamask/design-system-react';

import { TextVariant as LegacyTextVariant } from '../../../helpers/constants/design-system';
import {
  Content,
  Header,
  Page,
} from '../../../components/multichain/pages/page';
import {
  HardwareDeviceNames,
  TREZOR_USB_VENDOR_IDS,
} from '../../../../shared/constants/hardware-wallets';
import { MetaMetricsEventName } from '../../../../shared/constants/metametrics';
import { MetaMetricsContext } from '../../../contexts/metametrics';
import { useI18nContext } from '../../../hooks/useI18nContext';
import { PREVIOUS_ROUTE } from '../../../helpers/constants/routes';

const isUSBSupported = !process.env.IN_TEST && window.navigator.usb;

type WalletOptionBase = {
  id: string;
  labelKey: string;
  device: HardwareDeviceNames;
  testId: string;
};

type WalletOptionWithImage = WalletOptionBase & {
  type: 'image';
  imageSrc: string;
};

type WalletOptionWithIcon = WalletOptionBase & {
  type: 'icon';
  iconName: IconName;
};

type WalletOption = WalletOptionWithImage | WalletOptionWithIcon;

const WALLET_OPTIONS: WalletOption[] = [
  {
    id: 'ledger',
    type: 'image',
    labelKey: 'ledger',
    device: HardwareDeviceNames.ledger,
    testId: 'connect-hardware-wallet-ledger',
    imageSrc: 'images/hardware-wallets/ledger.svg',
  },
  {
    id: 'keystone',
    type: 'image',
    labelKey: 'keystone',
    device: HardwareDeviceNames.qr,
    testId: 'connect-hardware-wallet-keystone',
    imageSrc: 'images/hardware-wallets/keystone.svg',
  },
  {
    id: 'trezor',
    type: 'image',
    labelKey: 'trezor',
    device: HardwareDeviceNames.trezor,
    testId: 'connect-hardware-wallet-trezor',
    imageSrc: 'images/hardware-wallets/trezor.svg',
  },
  {
    id: 'onekey',
    type: 'image',
    labelKey: 'oneKey',
    device: HardwareDeviceNames.oneKey,
    testId: 'connect-hardware-wallet-onekey',
    imageSrc: 'images/hardware-wallets/onekey.svg',
  },
  {
    id: 'lattice',
    type: 'image',
    labelKey: 'lattice',
    device: HardwareDeviceNames.lattice,
    testId: 'connect-hardware-wallet-lattice',
    imageSrc: 'images/hardware-wallets/lattice.svg',
  },
  {
    id: 'other-qr',
    type: 'icon',
    labelKey: 'otherQrWallet',
    device: HardwareDeviceNames.qr,
    testId: 'connect-hardware-wallet-other-qr',
    iconName: IconName.QrCode,
  },
];

type SelectHardwareProps = {
  connectToHardwareWallet: (device: string) => void;
  browserSupported: boolean;
};

const SelectHardware = ({
  connectToHardwareWallet,
  browserSupported,
}: SelectHardwareProps) => {
  const t = useI18nContext();
  const navigate = useNavigate();
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
            filters: TREZOR_USB_VENDOR_IDS,
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

  const renderWalletIcon = (option: WalletOption) => {
    if (option.type === 'image') {
      return (
        <img
          className="select-hardware__wallet-image"
          src={option.imageSrc}
          alt=""
          width={40}
          height={40}
        />
      );
    }
    return (
      <div className="select-hardware__wallet-icon">
        <Icon
          name={option.iconName}
          size={IconSize.Lg}
          color={IconColor.IconAlternative}
        />
      </div>
    );
  };

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
    <Page className="select-hardware">
      <Header
        textProps={{
          variant: LegacyTextVariant.headingSm,
        }}
        startAccessory={
          <ButtonIcon
            iconName={IconName.ArrowLeft}
            size={ButtonIconSize.Md}
            ariaLabel={t('back') as string}
            onClick={() => navigate(PREVIOUS_ROUTE)}
            data-testid="hardware-connect-close-btn"
          />
        }
      >
        {t('connectAHardwareWallet')}
      </Header>
      <Content paddingLeft={4} paddingRight={4}>
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
              {renderWalletIcon(option)}
              <Text variant={TextVariant.BodyMd} fontWeight={FontWeight.Medium}>
                {t(option.labelKey)}
              </Text>
            </button>
          ))}
        </Box>
      </Content>
    </Page>
  );
};

export default SelectHardware;

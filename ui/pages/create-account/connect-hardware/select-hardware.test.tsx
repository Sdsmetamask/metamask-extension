import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HardwareDeviceNames } from '../../../../shared/constants/hardware-wallets';
import { renderWithProvider } from '../../../../test/lib/render-helpers-navigate';
import SelectHardware from './select-hardware';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../../../shared/lib/browser-runtime.utils', () => ({
  getBrowserName: () => 'chrome',
}));

describe('SelectHardware', () => {
  const mockConnectToHardwareWallet = jest.fn();

  const render = (browserSupported = true) =>
    renderWithProvider(
      <SelectHardware
        connectToHardwareWallet={mockConnectToHardwareWallet}
        browserSupported={browserSupported}
      />,
      undefined,
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders all hardware wallet options', () => {
    render();

    expect(
      screen.getByTestId('connect-hardware-wallet-ledger'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('connect-hardware-wallet-keystone'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('connect-hardware-wallet-trezor'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('connect-hardware-wallet-onekey'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('connect-hardware-wallet-lattice'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('connect-hardware-wallet-other-qr'),
    ).toBeInTheDocument();
  });

  it('renders wallet option labels', () => {
    render();

    expect(screen.getByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText('Keystone')).toBeInTheDocument();
    expect(screen.getByText('Trezor')).toBeInTheDocument();
    expect(screen.getByText('OneKey')).toBeInTheDocument();
    expect(screen.getByText('Lattice')).toBeInTheDocument();
    expect(screen.getByText('Other QR wallet')).toBeInTheDocument();
  });

  it('renders the page title', () => {
    render();

    expect(screen.getByText('Connect a hardware wallet')).toBeInTheDocument();
  });

  it('navigates to previous page when back button is clicked', () => {
    render();

    fireEvent.click(screen.getByTestId('hardware-connect-close-btn'));

    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  describe('wallet selection', () => {
    it('connects to Ledger', () => {
      render();
      fireEvent.click(screen.getByTestId('connect-hardware-wallet-ledger'));
      expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
        HardwareDeviceNames.ledger,
      );
    });

    it('connects to Keystone via QR device', () => {
      render();
      fireEvent.click(screen.getByTestId('connect-hardware-wallet-keystone'));
      expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
        HardwareDeviceNames.qr,
      );
    });

    it('connects to Trezor', () => {
      render();
      fireEvent.click(screen.getByTestId('connect-hardware-wallet-trezor'));
      expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
        HardwareDeviceNames.trezor,
      );
    });

    it('connects to OneKey', () => {
      render();
      fireEvent.click(screen.getByTestId('connect-hardware-wallet-onekey'));
      expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
        HardwareDeviceNames.oneKey,
      );
    });

    it('connects to Lattice', () => {
      render();
      fireEvent.click(screen.getByTestId('connect-hardware-wallet-lattice'));
      expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
        HardwareDeviceNames.lattice,
      );
    });

    it('connects to Other QR wallet via QR device', () => {
      render();
      fireEvent.click(screen.getByTestId('connect-hardware-wallet-other-qr'));
      expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
        HardwareDeviceNames.qr,
      );
    });
  });

  describe('unsupported browser', () => {
    it('shows unsupported browser message', () => {
      render(false);

      expect(
        screen.getByText('Your browser is not supported...'),
      ).toBeInTheDocument();
    });

    it('does not render wallet options', () => {
      render(false);

      expect(
        screen.queryByTestId('connect-hardware-wallet-ledger'),
      ).not.toBeInTheDocument();
    });
  });

  describe('Trezor USB flow', () => {
    const originalUsb = window.navigator.usb;

    beforeEach(() => {
      Object.defineProperty(window.navigator, 'usb', {
        value: {
          requestDevice: jest.fn().mockResolvedValue({}),
        },
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(window.navigator, 'usb', {
        value: originalUsb,
        writable: true,
        configurable: true,
      });
    });

    it('connects Trezor when USB is available', async () => {
      render();

      fireEvent.click(screen.getByTestId('connect-hardware-wallet-trezor'));

      await waitFor(() => {
        expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
          HardwareDeviceNames.trezor,
        );
      });
    });

    it('still connects when user cancels USB device selection', async () => {
      (window.navigator.usb.requestDevice as jest.Mock).mockRejectedValue(
        new Error('No device selected'),
      );

      render();

      fireEvent.click(screen.getByTestId('connect-hardware-wallet-trezor'));

      await waitFor(() => {
        expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
          HardwareDeviceNames.trezor,
        );
      });
    });
  });
});

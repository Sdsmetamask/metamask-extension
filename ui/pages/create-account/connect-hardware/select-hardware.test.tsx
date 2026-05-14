import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HardwareDeviceNames } from '../../../../shared/constants/hardware-wallets';
import { renderWithProvider } from '../../../../test/lib/render-helpers-navigate';
import SelectHardware from './select-hardware';

jest.mock('../../../../shared/lib/browser-runtime.utils', () => ({
  getBrowserName: () => 'chrome',
}));

describe('SelectHardware', () => {
  const mockOnCancel = jest.fn();
  const mockConnectToHardwareWallet = jest.fn();

  const render = (browserSupported = true) =>
    renderWithProvider(
      <SelectHardware
        onCancel={mockOnCancel}
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

  it('renders the page title', () => {
    render();

    expect(screen.getByText('Connect a hardware wallet')).toBeInTheDocument();
  });

  it('renders the back button', () => {
    render();

    expect(
      screen.getByTestId('hardware-connect-close-btn'),
    ).toBeInTheDocument();
  });

  it('calls onCancel when back button is clicked', () => {
    render();

    fireEvent.click(screen.getByTestId('hardware-connect-close-btn'));

    expect(mockOnCancel).toHaveBeenCalledTimes(1);
  });

  it('calls connectToHardwareWallet with ledger when Ledger is clicked', () => {
    render();

    fireEvent.click(screen.getByTestId('connect-hardware-wallet-ledger'));

    expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
      HardwareDeviceNames.ledger,
    );
  });

  it('calls connectToHardwareWallet with qr when Keystone is clicked', () => {
    render();

    fireEvent.click(screen.getByTestId('connect-hardware-wallet-keystone'));

    expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
      HardwareDeviceNames.qr,
    );
  });

  it('calls connectToHardwareWallet with trezor when Trezor is clicked', () => {
    render();

    fireEvent.click(screen.getByTestId('connect-hardware-wallet-trezor'));

    expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
      HardwareDeviceNames.trezor,
    );
  });

  it('calls connectToHardwareWallet with oneKey when OneKey is clicked', () => {
    render();

    fireEvent.click(screen.getByTestId('connect-hardware-wallet-onekey'));

    expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
      HardwareDeviceNames.oneKey,
    );
  });

  it('calls connectToHardwareWallet with lattice when Lattice is clicked', () => {
    render();

    fireEvent.click(screen.getByTestId('connect-hardware-wallet-lattice'));

    expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
      HardwareDeviceNames.lattice,
    );
  });

  it('calls connectToHardwareWallet with qr when Other QR wallet is clicked', () => {
    render();

    fireEvent.click(screen.getByTestId('connect-hardware-wallet-other-qr'));

    expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
      HardwareDeviceNames.qr,
    );
  });

  it('renders unsupported browser screen when browser is not supported', () => {
    render(false);

    expect(
      screen.getByText('Your browser is not supported...'),
    ).toBeInTheDocument();
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

    it('requests USB device before connecting Trezor when USB is supported', async () => {
      render();

      fireEvent.click(screen.getByTestId('connect-hardware-wallet-trezor'));

      await waitFor(() => {
        expect(mockConnectToHardwareWallet).toHaveBeenCalledWith(
          HardwareDeviceNames.trezor,
        );
      });
    });

    it('still connects Trezor when USB request is cancelled by user', async () => {
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

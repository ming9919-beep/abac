import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PhoneRegister from './PhoneRegister';
import { PHONE_NOT_REGISTERED_I18N, PHONE_NOT_REGISTERED_MESSAGE } from '@/lib/phoneRegistry';

const mockSetLocation = vi.fn();
vi.mock('wouter', () => ({
  useLocation: () => ['', mockSetLocation],
}));

const phoneRegistry = vi.hoisted(() => ({
  checkPhoneRegistered: vi.fn(),
}));
vi.mock('@/lib/phoneRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/phoneRegistry')>();
  return {
    ...actual,
    checkPhoneRegistered: phoneRegistry.checkPhoneRegistered,
  };
});

function pressDigits(digits: string) {
  const buttons = screen.getAllByRole('button');
  for (const d of digits) {
    // 数字键里可能带副标签（如 "0" 下面还有注音），按 textContent 匹配
    const btn = buttons.find((b) => (b.textContent ?? '').trim().startsWith(d));
    if (!btn) throw new Error(`找不到数字键 ${d}`);
    fireEvent.click(btn);
  }
}

describe('PhoneRegister: 未注册手机号无法登录', () => {
  beforeEach(() => {
    mockSetLocation.mockClear();
    phoneRegistry.checkPhoneRegistered.mockReset();
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('未注册手机号 → 显示三语拦截提示，且不跳转到 OTP 页', async () => {
    phoneRegistry.checkPhoneRegistered.mockResolvedValue({
      registered: false,
      status: null,
      message: '你手机号码目前还没注册本银行使用 / This phone number is not registered with this bank yet',
      source: 'server',
    });

    render(<PhoneRegister />);
    pressDigits('011222333');
    fireEvent.click(screen.getByText('បន្ទាប់'));

    await waitFor(() => {
      expect(phoneRegistry.checkPhoneRegistered).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(screen.getByText(PHONE_NOT_REGISTERED_I18N.km)).toBeInTheDocument();
    expect(screen.getByText(PHONE_NOT_REGISTERED_I18N.zh)).toBeInTheDocument();
    expect(screen.getByText(/not registered with this bank/i)).toBeInTheDocument();

    // 不允许进入下一步
    expect(mockSetLocation).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('aba.pendingPhone')).toBeNull();
  });

  it('已注册手机号 → 通过校验并进入 OTP 页', async () => {
    phoneRegistry.checkPhoneRegistered.mockResolvedValue({
      registered: true,
      status: 'active',
      message: '手机号已注册本银行使用 / This phone number is registered',
      source: 'server',
    });

    render(<PhoneRegister />);
    pressDigits('0979935561');
    fireEvent.click(screen.getByText('បន្ទាប់'));

    await waitFor(() => {
      expect(mockSetLocation).toHaveBeenCalledWith('/auth/otp');
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sessionStorage.getItem('aba.pendingPhone')).toBe('855979935561');
    // 进 OTP 前记下来源，OTP 返回键能回到登录页
    expect(sessionStorage.getItem('aba.back:/auth/otp')).toBe('/auth/register');
  });

  it('未注册 → 拦截提示里有「立即注册开户」，点了带号码跳开户页', async () => {
    phoneRegistry.checkPhoneRegistered.mockResolvedValue({
      registered: false,
      status: null,
      message: PHONE_NOT_REGISTERED_MESSAGE,
      source: 'server',
    });

    render(<PhoneRegister />);
    pressDigits('011888777');
    fireEvent.click(screen.getByText('បន្ទាប់'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/立即注册开户/));

    expect(mockSetLocation).toHaveBeenCalledWith('/auth/signup');
    // 记住来源 + 预填号码，开户页返回键与手机号都不用重来
    expect(sessionStorage.getItem('aba.back:/auth/signup')).toBe('/auth/register');
    expect(sessionStorage.getItem('aba.signupPhone')).toBe('85511888777');
  });

  it('不触发拦截也有常驻「立即注册」入口', () => {
    render(<PhoneRegister />);
    fireEvent.click(screen.getByText(/· 立即注册$/));

    expect(mockSetLocation).toHaveBeenCalledWith('/auth/signup');
    expect(sessionStorage.getItem('aba.back:/auth/signup')).toBe('/auth/register');
  });
});

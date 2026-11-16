import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Signup from './Signup';

const mockSetLocation = vi.fn();
vi.mock('wouter', () => ({
  useLocation: () => ['', mockSetLocation],
}));

const walletAuth = vi.hoisted(() => ({
  registerAccount: vi.fn(),
}));
vi.mock('@/lib/walletAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/walletAuth')>();
  return {
    ...actual,
    registerAccount: walletAuth.registerAccount,
  };
});

/** 填满整个开户表单（手机号 / 姓名 / 身份证 / 密码 / 确认密码） */
function fillForm(overrides: Partial<Record<string, string>> = {}) {
  const values: Record<string, string> = {
    phone: '0979935561',
    fullName: 'CHHENG BONNY',
    nationalIdNo: '493991234567',
    password: 'Smoke#2026',
    confirm: 'Smoke#2026',
    ...overrides,
  };
  const set = (label: RegExp, v: string) => {
    const input = screen.getByLabelText(label) as HTMLInputElement;
    fireEvent.change(input, { target: { value: v } });
  };
  set(/手机号/, values.phone);
  set(/姓名/, values.fullName);
  set(/身份证号/, values.nationalIdNo);
  // 密码标签是高棉语在前（ពាក្យសម្ងាត់ · 密码），用 placeholder 精确定位
  fireEvent.change(screen.getByPlaceholderText('至少 8 位，含字母+数字'), {
    target: { value: values.password },
  });
  set(/确认密码/, values.confirm);
}

describe('Signup: 开户必须完成身份证信息', () => {
  beforeEach(() => {
    mockSetLocation.mockClear();
    walletAuth.registerAccount.mockReset();
    try {
      sessionStorage.removeItem('aba.pendingPhone');
    } catch {
      /* ignore */
    }
  });

  it('证件号为空 → 提交按钮不可用，且提示必须填写', async () => {
    walletAuth.registerAccount.mockResolvedValue({
      ok: true,
      source: 'server',
      message: 'ok',
    });

    render(<Signup />);
    fillForm({ nationalIdNo: '' });

    const submit = screen.getByRole('button', { name: /完成开户/ });
    expect(submit).toBeDisabled();

    // 失焦触发字段级校验，展示必填文案（字段错误带 AlertCircle 图标，取最后一个即字段级）
    fireEvent.blur(screen.getByLabelText(/身份证号/));
    await waitFor(() => {
      const hits = screen.getAllByText(/开户必须完成身份证信息/);
      expect(hits.length).toBeGreaterThanOrEqual(1);
    });

    expect(walletAuth.registerAccount).not.toHaveBeenCalled();
    expect(mockSetLocation).not.toHaveBeenCalled();
  });

  it('证件号过短（<4 位）→ 被拦下，不提交', async () => {
    render(<Signup />);
    fillForm({ nationalIdNo: '12' });

    expect(screen.getByRole('button', { name: /完成开户/ })).toBeDisabled();
    expect(walletAuth.registerAccount).not.toHaveBeenCalled();
  });

  it('信息齐全 → 提交注册，成功后进入 OTP 页', async () => {
    walletAuth.registerAccount.mockResolvedValue({
      ok: true,
      source: 'server',
      message: '注册成功',
      token: 'tok',
    });

    render(<Signup />);
    fillForm();

    fireEvent.click(screen.getByRole('button', { name: /完成开户/ }));

    await waitFor(() => {
      expect(walletAuth.registerAccount).toHaveBeenCalledTimes(1);
    });
    expect(walletAuth.registerAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '0979935561',
        fullName: 'CHHENG BONNY',
        nationalIdNo: '493991234567',
      }),
    );
    await waitFor(() => {
      expect(mockSetLocation).toHaveBeenCalledWith('/auth/otp');
    });
    expect(sessionStorage.getItem('aba.pendingPhone')).toBe('855979935561');
  });

  it('服务端拒绝（如证件号已存在）→ 展示错误且不跳转', async () => {
    walletAuth.registerAccount.mockResolvedValue({
      ok: false,
      source: 'error',
      message: '证件号已被使用',
    });

    render(<Signup />);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /完成开户/ }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText('证件号已被使用')).toBeInTheDocument();
    expect(mockSetLocation).not.toHaveBeenCalled();
  });
});

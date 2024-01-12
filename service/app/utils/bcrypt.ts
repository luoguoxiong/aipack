import bcrypt from 'bcrypt';

const SaltRounds = 5;

// 加密密码
export async function encryptPassword(plainPassword: string): Promise<string> {
  try {
    const hashedPassword = await bcrypt.hash(plainPassword, SaltRounds);
    return hashedPassword;
  } catch (error) {
    throw error;
  }
}

// 验证密码
export async function comparePassword(enteredPassword: string, hashedPassword: string): Promise<boolean> {
  try {
    const result = await bcrypt.compare(enteredPassword, hashedPassword);
    return result;
  } catch (error) {
    throw error;
  }
}

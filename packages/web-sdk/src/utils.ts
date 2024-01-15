export const generateShortUUID = () => {
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let shortUUID = '';

  for (let i = 0; i < 8; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    shortUUID += characters.charAt(randomIndex);
  }

  return shortUUID + Date.now();
};

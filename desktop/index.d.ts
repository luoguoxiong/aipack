declare module '*.svg'
declare module '*.css'
declare module '*.less'
declare module '*.scss'
declare module '*.png'


type BluBiuRes<T> = {
  code: number;
  message: string;
  data: T;
}

type BluBiuResponse<T> = Promise<BluBiuRes<T>>

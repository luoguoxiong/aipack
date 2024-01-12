import React, { useState }from 'react';
import { Input, message as Message, Modal } from 'antd';
import { useNavigate } from 'react-router';
import { useDispatch } from 'react-redux';
import css from './index.module.less';
import { login, register } from '@/src/api/index';
import { Dispatch } from '@/src/models/store';
enum ActionType{
  Login = 0,
  Regist
}
const LoginPage = () => {
  const dispatch = useDispatch<Dispatch>();
  const navigate = useNavigate();
  const [type, setType] = useState(ActionType.Login);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({
    user: '',
    pwd: '',
  });

  const formChange = (val: string, key: string) => {
    setForm({
      ...form,
      [key]: val,
    });
  };

  const showAction = (type: ActionType) => {
    setShow(true);
    setType(type);
    setForm({
      user: '',
      pwd: '',
    });
  };

  const toLogin = async() => {
    try {
      await login({
        account: form.user,
        password: form.pwd,
      });
      navigate('/');
    } catch (error) {
      console.log(error);
    }
  };



  const toSubmit = async(type: ActionType) => {
    try {
      const { user, pwd } = form;
      const reg = /^[a-zA-Z0-9]{6,10}$/;
      if(!reg.test(user) || !reg.test(pwd)){
        return Message.error('请输入长度6~10，只包含数字和字母的账号和密码');
      }
      if(type === ActionType.Login){
        toLogin();
      }else{
        await register({
          account: form.user,
          password: form.pwd,
        });
        Modal.confirm({
          content: '立即登录？',
          onOk: async() => {
            toLogin();
          },
        });
      }
    } catch (error) {
      console.log(error);
    }
  };
  return (
    <div className={css['login']}>
      <div className={css['login-card']}>
        <div
          className={css['btn']}
          onClick={() => {
            showAction(ActionType.Login);
          }}>登录
        </div>
        <div
          className={css['btn']}
          onClick={() => {
            showAction(ActionType.Regist);
          }}
        >注册
        </div>
      </div>
      {
        show && (
          <div
            className={css['login-content']}
            onClick={(e) => {
              if(e.target !== e.currentTarget){
                return;
              }
              setShow(false);
            }}>
            <div className={css['login-body']} >
              <div className={css.title}>{type === ActionType.Login ? '登录BLUBIU系统' : '注册BLUBIU账号'}</div>
              <Input
                style={{ margin: '20px 0', height: 40 }}
                placeholder="请输入账号"
                value={form.user}
                onChange={(e) => {
                  formChange(e.target.value, 'user');
                }}
                prefix={<span className={css['site-form-item-icon']}>帐号：</span>}
              />
              <Input
                style={{ height: 40 }}
                placeholder="请输入密码"
                type="password"
                value={form.pwd}
                onChange={(e) => {
                  formChange(e.target.value, 'pwd');
                }}
                prefix={<span className={css['site-form-item-icon']}>密码：</span>}
              />
              <div
                className={css['action']}
                onClick={() => {
                  toSubmit(type);
                }}>{type === ActionType.Login ? '登录' : '注册'}
              </div>
            </div>
          </div>
        )
      }
    </div>
  );
};
export default LoginPage;

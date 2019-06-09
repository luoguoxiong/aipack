import React, { Component } from 'react'
import './index.scss'
import isCheck from '../../static/img/isCheck.png'
import noCheck from '../../static/img/noCheck.png'
import { Modal, PickerView, Button, Toast } from 'antd-mobile'
import address from './address'
class AddressSet extends Component {
  constructor(props) {
    super(props)
    this._name = React.createRef()
    this._phone = React.createRef()
    this._address = React.createRef()
  }
  componentDidMount() {
    if (this.props.addressDoType === -1) {
      const {
        name,
        city_id,
        district_id,
        province_id,
        is_default,
        mobile,
        address,
        id
      } = this.props.addressInfo
      this.id = id
      this._name.current.value = name
      this._phone.current.value = mobile
      this._address.current.value = address
      this.setState({
        isDefault: is_default,
        pickerVal: [province_id, city_id, district_id]
      })
    }
  }
  state = {
    isDefault: false,
    visible: false,
    pickerVal: [2, 37, 403]
  }
  changeDetault = status => {
    this.setState({
      isDefault: !status
    })
  }
  openModel = () => {
    this.setState({
      visible: true
    })
  }
  findAddressName = (province_id, city_id, region_id) => {
    let str = ''
    const provicess = address.filter(item => {
      return province_id === item.value
    })
    if (provicess.length === 1) {
      str += provicess[0].label
      const citys = provicess[0].children.filter(item => {
        return city_id === item.value
      })
      if (citys.length === 1) {
        str += `/${citys[0].label}`
        const countrys = citys[0].children.filter(item => {
          return region_id === item.value
        })
        if (countrys.length === 1) {
          str += `/${countrys[0].label}`
        }
      }
    }
    return str
  }
  submitForm() {
    const { addressDoType } = this.props
    const [province_id, city_id, district_id] = this.state.pickerVal
    if (this._name.current.value === '') {
      Toast.fail('姓名不能为空！')
      return
    }
    if (this._phone.current.value === '') {
      Toast.fail('手机号码不能为空！')
      return
    }
    if (!/^1([38]\d|5[0-35-9]|7[3678])\d{8}$/.test(this._phone.current.value)) {
      Toast.fail('请输入正确的手机号码！')
      return
    }
    const parmas = {
      name: this._name.current.value,
      mobile: this._phone.current.value,
      province_id,
      city_id,
      district_id,
      address: this._address.current.value,
      is_default: this.state.isDefault ? true : false
    }
    if (addressDoType === -1) {
      parmas.id = this.id
    }
    this.props.closeAddressDo(parmas)
  }
  closeDo = () => {
    this.props.closeDo()
  }
  render() {
    const { isDefault, pickerVal } = this.state
    const { addressDoType } = this.props
    const addressName = this.findAddressName(...pickerVal)
    return (
      <div className="addressSetPage">
        <div className="addressHeader">
          {addressDoType === 1 ? '新增' : '修改'}地址
        </div>
        <div className="onePx_bottom">
          <input className="addressInput" ref={this._name} placeholder="姓名" />
        </div>
        <div className="onePx_bottom">
          <input
            className="addressInput"
            ref={this._phone}
            placeholder="电话号码"
          />
        </div>
        <div className="onePx_bottom" onClick={this.openModel}>
          <div className="chooseAddress">{addressName}</div>
        </div>
        <div className="onePx_bottom">
          <input
            className="addressInput"
            ref={this._address}
            placeholder="详细地址"
          />
        </div>
        <div className="onePx_bottom">
          <div
            className="isDefaultAddress"
            onClick={this.changeDetault.bind(this, isDefault)}
          >
            设置默认地址
            <img src={isDefault ? isCheck : noCheck} alt="check" />
          </div>
        </div>
        <div className="closeAddress">
          <div>
            <Button
              inline
              onClick={this.closeDo.bind(this)}
              style={{
                marginRight: '4px',
                lineHeight: '1rem',
                height: '1rem',
                width: '100%',
                borderRadius: 0
              }}
            >
              取消
            </Button>
          </div>
          <div>
            <Button
              type="primary"
              inline
              onClick={this.submitForm.bind(this)}
              style={{
                marginRight: '4px',
                lineHeight: '1rem',
                height: '1rem',
                width: '100%',
                borderRadius: 0
              }}
            >
              保存
            </Button>
          </div>
        </div>
        {this.renderModel()}
      </div>
    )
  }

  closeModel(val) {
    this.setState({
      visible: !val
    })
  }

  renderModel() {
    const { visible } = this.state
    return (
      <Modal
        popup
        onClose={this.closeModel.bind(this, visible)}
        visible={visible}
        animationType="slide-up"
      >
        <div className="modelCloseWrap onePx_bottom">
          <div
            className="pickBtn"
            onClick={this.closeModel.bind(this, visible)}
          >
            取消
          </div>
          <div
            className="pickBtn"
            onClick={this.closeModel.bind(this, visible)}
          >
            确定
          </div>
        </div>
        {this.renderPickerView()}
      </Modal>
    )
  }

  pcickerChange = val => {
    this.setState({ pickerVal: val })
  }

  renderPickerView() {
    const { pickerVal } = this.state
    return (
      <PickerView
        onChange={this.pcickerChange}
        data={address}
        value={pickerVal}
      />
    )
  }
}
export default AddressSet

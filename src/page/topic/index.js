import React, { Component, Fragment } from 'react'
import { connect } from 'react-redux'
import { bindActionCreators } from 'redux'
import * as topicAction from '../../redux/actions/topic'
import LazyLoad from 'react-lazyload'
import { Link } from 'react-router-dom'
import ImgLazyLoad from '../../components/imgLazyLoad'
import './index.css'
class Topic extends Component {
  componentWillMount() {
    this.props.actions.fetchData({ page: 1, size: 100 })
  }
  render() {
    const { topicData } = this.props
    return (
      <Fragment>
        {topicData.map(item => (
          <LazyLoad throttle={200} height={300} key={item.id}>
            <Link className="topicItem" to={`/topicDetail/${item.id}`}>
              <ImgLazyLoad offSetTop={44} realUrl={item.scene_pic_url} />
              <div className="topicItemTitle">{item.title}</div>
              <div className="topicItemSubtitle">{item.subtitle}</div>
              <div className="topicItemPrice">{item.price_info}元起</div>
            </Link>
          </LazyLoad>
        ))}
      </Fragment>
    )
  }
}
const mapStateToProps = (state, props) => ({ ...state.topic })
const mapDispatchToProps = dispatch => ({
  actions: bindActionCreators(topicAction, dispatch)
})
export default connect(
  mapStateToProps,
  mapDispatchToProps
)(Topic)

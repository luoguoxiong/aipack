import React, {Component, Fragment} from 'react'
import './index.scss'
class CommentList extends Component{
  render () {
    const { commentList} = this.props
    return (
      <Fragment>
        <div className="commentList">
          {commentList.map((item, index) => {
            return (
              <div className="commentItem" key={item.content + index}>
                <div className="userInfo">
                  <div>{'user_info' in item && 'username' in item.user_info?item.user_info.username:'匿名用户'}</div>
                  <div>{item.add_time}</div>
                </div>
                <div className="userComment">{item.content}</div>
                <div className="commentPicList">
                    {
                        item.pic_list.map((item) => {
                            return <img src={item.pic_url} key={item.id} alt={item.id}/>
                        })
                    }
                </div>
              </div>
            )
          })}
        </div>
      </Fragment>
    )
  }
}
export default CommentList
